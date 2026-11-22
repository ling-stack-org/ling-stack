package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"
	"unicode/utf8"

	"github.com/pion/webrtc/v4"
)

const (
	maxFrameBytes = 256 * 1024
	maxLineBytes  = 6*maxFrameBytes + 4096
	maxBuffered   = 4 * maxFrameBytes
	channelLabel  = "ling-peer"
	channelProto  = "ling-peer.v1"
)

type request struct {
	ID          uint64                     `json:"id"`
	Type        string                     `json:"type"`
	Config      *configuration             `json:"configuration,omitempty"`
	Negotiated  bool                       `json:"negotiated,omitempty"`
	Description *webrtc.SessionDescription `json:"description,omitempty"`
	Candidate   *webrtc.ICECandidateInit   `json:"candidate,omitempty"`
	Text        string                     `json:"text,omitempty"`
}

type configuration struct {
	ICEServers         []webrtc.ICEServer `json:"iceServers"`
	ICETransportPolicy string             `json:"iceTransportPolicy"`
}

type notification struct {
	ID    uint64 `json:"id,omitempty"`
	Type  string `json:"type"`
	Value any    `json:"value,omitempty"`
}

type worker struct {
	writer  *json.Encoder
	wire    sync.Mutex
	peer    *webrtc.PeerConnection
	channel *webrtc.DataChannel
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		os.Exit(1)
	}
}

func run(input io.Reader, output io.Writer) error {
	w := worker{writer: json.NewEncoder(output)}
	defer func() {
		if w.peer != nil {
			_ = w.peer.Close()
		}
	}()
	scan := bufio.NewScanner(input)
	scan.Buffer(make([]byte, 4096), maxLineBytes)
	var previousID uint64
	for scan.Scan() {
		var command request
		decoder := json.NewDecoder(bytes.NewReader(scan.Bytes()))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&command); err != nil || decoder.Decode(new(any)) != io.EOF || command.ID <= previousID {
			return errors.New("invalid worker request")
		}
		previousID = command.ID
		if command.Type == "close" {
			return nil
		}
		result, err := w.apply(command)
		if err != nil {
			w.emit(notification{ID: command.ID, Type: "rejected"})
			return err
		}
		w.emit(notification{ID: command.ID, Type: "result", Value: result})
	}
	return scan.Err()
}

func (w *worker) apply(command request) (any, error) {
	if command.Type == "initialize" {
		if w.peer != nil || command.Config == nil {
			return nil, errors.New("invalid initialization")
		}
		return nil, w.initialize(*command.Config)
	}
	if w.peer == nil {
		return nil, errors.New("peer unavailable")
	}
	switch command.Type {
	case "open_channel":
		if w.channel != nil {
			return nil, errors.New("channel already configured")
		}
		protocol := channelProto
		init := webrtc.DataChannelInit{Protocol: &protocol}
		if command.Negotiated {
			id := uint16(0)
			init.Negotiated = &command.Negotiated
			init.ID = &id
		}
		channel, err := w.peer.CreateDataChannel(channelLabel, &init)
		if err != nil {
			return nil, err
		}
		w.watchChannel(channel)
		return nil, nil
	case "create_offer":
		return w.peer.CreateOffer(nil)
	case "create_answer":
		return w.peer.CreateAnswer(nil)
	case "set_local_description", "set_remote_description":
		desc := command.Description
		if desc == nil || (desc.Type != webrtc.SDPTypeOffer && desc.Type != webrtc.SDPTypeAnswer) || len(desc.SDP) == 0 || len(desc.SDP) > 32*1024 {
			return nil, errors.New("invalid peer description")
		}
		if command.Type == "set_local_description" {
			return nil, w.peer.SetLocalDescription(*desc)
		}
		return nil, w.peer.SetRemoteDescription(*desc)
	case "add_candidate":
		if command.Candidate == nil {
			return nil, errors.New("remote candidate missing")
		}
		return nil, w.peer.AddICECandidate(*command.Candidate)
	case "send":
		if w.channel == nil || len(command.Text) > maxFrameBytes || !utf8.ValidString(command.Text) ||
			w.channel.BufferedAmount()+uint64(len(command.Text)) > maxBuffered {
			return nil, errors.New("data channel unavailable")
		}
		return nil, w.channel.SendText(command.Text)
	default:
		return nil, errors.New("unknown worker request")
	}
}

func (w *worker) initialize(config configuration) error {
	if len(config.ICEServers) > 16 {
		return errors.New("too many ICE servers")
	}
	policy := webrtc.ICETransportPolicyAll
	switch config.ICETransportPolicy {
	case "", "all":
	case "relay":
		policy = webrtc.ICETransportPolicyRelay
	default:
		return errors.New("invalid ICE policy")
	}
	var settings webrtc.SettingEngine
	settings.SetSCTPMaxMessageSize(maxFrameBytes)
	peer, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{
		ICEServers: config.ICEServers, ICETransportPolicy: policy,
	})
	if err != nil {
		return err
	}
	w.peer = peer
	peer.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			w.emit(notification{Type: "candidate", Value: candidate.ToJSON()})
		}
	})
	peer.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		w.emit(notification{Type: "peer_state", Value: state.String()})
	})
	peer.OnDataChannel(func(channel *webrtc.DataChannel) {
		_ = channel.Close()
		w.emit(notification{Type: "channel_error"})
	})
	return nil
}

func (w *worker) watchChannel(channel *webrtc.DataChannel) {
	w.channel = channel
	channel.OnOpen(func() {
		w.emit(notification{Type: "channel_open"})
	})
	channel.OnClose(func() {
		w.emit(notification{Type: "channel_closed"})
	})
	channel.OnError(func(_ error) {
		w.emit(notification{Type: "channel_error"})
	})
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		if !message.IsString || len(message.Data) > maxFrameBytes || !utf8.Valid(message.Data) {
			w.emit(notification{Type: "channel_error"})
			_ = channel.Close()
			return
		}
		w.emit(notification{Type: "message", Value: string(message.Data)})
	})
}

func (w *worker) emit(event notification) {
	w.wire.Lock()
	defer w.wire.Unlock()
	if err := w.writer.Encode(event); err != nil {
		os.Exit(1)
	}
}
