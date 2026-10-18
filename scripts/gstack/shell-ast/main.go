package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"unicode/utf8"

	"mvdan.cc/sh/v3/syntax"
)

const (
	maxScriptBytes   = 2 * 1024 * 1024
	maxProtocolBytes = 64 * 1024 * 1024
	maxScripts       = 10_000
	maxCalls         = 100_000
)

type scriptInput struct {
	Path        string `json:"path"`
	BytesBase64 string `json:"bytesBase64"`
}

type request struct {
	SchemaVersion int           `json:"schemaVersion"`
	Scripts       []scriptInput `json:"scripts"`
}

type argument struct {
	Start     uint     `json:"start"`
	End       uint     `json:"end"`
	Raw       string   `json:"raw"`
	Literal   *string  `json:"literal"`
	PartKinds []string `json:"partKinds"`
}

type callSite struct {
	Start     uint       `json:"start"`
	End       uint       `json:"end"`
	Line      uint       `json:"line"`
	Column    uint       `json:"column"`
	Arguments []argument `json:"arguments"`
}

type scriptResult struct {
	Path      string     `json:"path"`
	Checksum  string     `json:"checksum"`
	SizeBytes int        `json:"sizeBytes"`
	Calls     []callSite `json:"calls"`
}

type response struct {
	SchemaVersion int            `json:"schemaVersion"`
	Parser        string         `json:"parser"`
	ParserVersion string         `json:"parserVersion"`
	Dialect       string         `json:"dialect"`
	Validation    string         `json:"validationMode"`
	Scripts       []scriptResult `json:"scripts"`
}

func main() {
	input, err := decodeRequest(os.Stdin)
	if err == nil {
		var result response
		result, err = parseRequest(input)
		if err == nil {
			var output []byte
			output, err = json.Marshal(result)
			if err == nil && len(output) > maxProtocolBytes {
				err = errors.New("output budget exceeded")
			}
			if err == nil {
				_, err = os.Stdout.Write(append(output, '\n'))
			}
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "gstack_shell_ast:", err)
		os.Exit(1)
	}
}

func decodeRequest(reader io.Reader) (request, error) {
	var input request
	raw, err := io.ReadAll(io.LimitReader(reader, maxProtocolBytes+1))
	if err != nil || len(raw) > maxProtocolBytes {
		return input, errors.New("input budget exceeded or read failed")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return input, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return input, errors.New("trailing protocol data")
	}
	return input, nil
}

func parseRequest(input request) (response, error) {
	result := response{SchemaVersion: 1, Parser: "mvdan.cc/sh/v3/syntax",
		ParserVersion: "v3.14.1", Dialect: "bash", Validation: "parse-only",
		Scripts: make([]scriptResult, 0, len(input.Scripts))}
	if input.SchemaVersion != 1 || len(input.Scripts) < 1 || len(input.Scripts) > maxScripts {
		return result, errors.New("invalid protocol identity or script count")
	}
	paths := make(map[string]bool)
	totalBytes, totalCalls := 0, 0
	for _, script := range input.Scripts {
		if !validPath(script.Path) || paths[strings.ToLower(script.Path)] {
			return result, errors.New("invalid or duplicate script path")
		}
		paths[strings.ToLower(script.Path)] = true
		if len(script.BytesBase64) > base64.StdEncoding.EncodedLen(maxScriptBytes) {
			return result, errors.New("script budget exceeded")
		}
		raw, err := base64.StdEncoding.Strict().DecodeString(script.BytesBase64)
		if err != nil || base64.StdEncoding.EncodeToString(raw) != script.BytesBase64 || !utf8.Valid(raw) {
			return result, errors.New("noncanonical script bytes")
		}
		totalBytes += len(raw)
		if len(raw) > maxScriptBytes || totalBytes > maxProtocolBytes {
			return result, errors.New("script budget exceeded")
		}
		tree, err := syntax.NewParser(syntax.Variant(syntax.LangBash)).Parse(bytes.NewReader(raw), script.Path)
		if err != nil {
			return result, err
		}
		digest := sha256.Sum256(raw)
		parsed := scriptResult{Path: script.Path, Checksum: "sha256:" + hex.EncodeToString(digest[:]),
			SizeBytes: len(raw), Calls: make([]callSite, 0)}
		var walkError error
		syntax.Walk(tree, func(node syntax.Node) bool {
			if walkError != nil {
				return false
			}
			call, ok := node.(*syntax.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			totalCalls++
			if totalCalls > maxCalls || !validSpan(call, raw) {
				walkError = errors.New("invalid call span or call budget exceeded")
				return false
			}
			site := callSite{Start: call.Pos().Offset(), End: call.End().Offset(),
				Line: call.Pos().Line(), Column: call.Pos().Col(), Arguments: make([]argument, 0, len(call.Args))}
			for wordIndex, word := range call.Args {
				if !validSpan(word, raw) {
					walkError = errors.New("invalid word span")
					return false
				}
				literal := literalParts(word.Parts, false)
				// A singleton command-position '[' cannot form a glob. Concatenated
				// words and non-command arguments retain conservative classification.
				if wordIndex == 0 && len(word.Parts) == 1 {
					if part, ok := word.Parts[0].(*syntax.Lit); ok && part.Value == "[" {
						literal = &part.Value
					}
				}
				arg := argument{Start: word.Pos().Offset(), End: word.End().Offset(),
					Raw: string(raw[word.Pos().Offset():word.End().Offset()]), Literal: literal,
					PartKinds: make([]string, 0)}
				syntax.Walk(word, func(part syntax.Node) bool {
					if _, ok := part.(syntax.WordPart); ok {
						arg.PartKinds = append(arg.PartKinds, strings.TrimPrefix(fmt.Sprintf("%T", part), "*syntax."))
					}
					return true
				})
				site.Arguments = append(site.Arguments, arg)
			}
			parsed.Calls = append(parsed.Calls, site)
			return true
		})
		if walkError != nil {
			return result, walkError
		}
		sort.SliceStable(parsed.Calls, func(i, j int) bool {
			if parsed.Calls[i].Start != parsed.Calls[j].Start {
				return parsed.Calls[i].Start < parsed.Calls[j].Start
			}
			return parsed.Calls[i].End < parsed.Calls[j].End
		})
		result.Scripts = append(result.Scripts, parsed)
	}
	return result, nil
}

func validPath(path string) bool {
	if path == "" || strings.HasPrefix(path, "/") {
		return false
	}
	for _, character := range path {
		if !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || strings.ContainsRune("._/-", character)) {
			return false
		}
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func validSpan(node syntax.Node, raw []byte) bool {
	return node.Pos().IsValid() && node.End().IsValid() && node.Pos().Line() > 0 && node.Pos().Col() > 0 &&
		node.Pos().Offset() <= node.End().Offset() && node.End().Offset() <= uint(len(raw))
}

// Expansion and escape semantics stay unresolved; this is an inventory, not a
// shell evaluator. Even an apparent constant is unknown when quoting is complex.
func literalParts(parts []syntax.WordPart, quoted bool) *string {
	var value strings.Builder
	for _, part := range parts {
		switch item := part.(type) {
		case *syntax.Lit:
			if strings.Contains(item.Value, "\\") || !quoted && strings.ContainsAny(item.Value, "*?[{~") {
				return nil
			}
			value.WriteString(item.Value)
		case *syntax.SglQuoted:
			if item.Dollar {
				return nil
			}
			value.WriteString(item.Value)
		case *syntax.DblQuoted:
			if item.Dollar {
				return nil
			}
			inner := literalParts(item.Parts, true)
			if inner == nil {
				return nil
			}
			value.WriteString(*inner)
		default:
			return nil
		}
	}
	text := value.String()
	return &text
}
