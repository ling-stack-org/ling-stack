package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func requestFor(path, source string) request {
	return request{SchemaVersion: 1, Scripts: []scriptInput{{Path: path,
		BytesBase64: base64.StdEncoding.EncodeToString([]byte(source))}}}
}

func TestCallsDistinguishCommentsAndLiteralHereDocuments(t *testing.T) {
	source := "# source phantom-comment.sh\ncat <<'END'\nsource phantom-document.sh\nEND\nprintf '%s' 'source phantom-string.sh'\nsource \"$GSTACK_ROOT/bin/helper.sh\"\n. './other.sh'\n"
	result, err := parseRequest(requestFor("bin/main.sh", source))
	if err != nil {
		t.Fatal(err)
	}
	calls := result.Scripts[0].Calls
	if len(calls) != 4 {
		t.Fatalf("got %d calls, want 4: %#v", len(calls), calls)
	}
	for index, name := range []string{"cat", "printf", "source", "."} {
		if calls[index].Arguments[0].Literal == nil || *calls[index].Arguments[0].Literal != name {
			t.Fatalf("call %d did not retain %q", index, name)
		}
	}
	if calls[2].Arguments[1].Literal != nil || !strings.Contains(strings.Join(calls[2].Arguments[1].PartKinds, ","), "ParamExp") {
		t.Fatal("parameter-expanded source was incorrectly resolved as literal")
	}
	if calls[3].Arguments[1].Literal == nil || *calls[3].Arguments[1].Literal != "./other.sh" {
		t.Fatal("single-quoted literal source path was lost")
	}
}

func TestExpansionCommandsRemainVisible(t *testing.T) {
	source := "cat <<END\n$(printf 'expanded')\nEND\nsource <(printf 'generated')\nvalue=$(dirname \"$0\")\n"
	result, err := parseRequest(requestFor("expansions.sh", source))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, call := range result.Scripts[0].Calls {
		if call.Arguments[0].Literal != nil {
			names = append(names, *call.Arguments[0].Literal)
		}
	}
	if strings.Join(names, ",") != "cat,printf,source,printf,dirname" {
		t.Fatalf("expansion commands missing: %v", names)
	}
	if !strings.Contains(strings.Join(result.Scripts[0].Calls[2].Arguments[1].PartKinds, ","), "ProcSubst") {
		t.Fatal("process substitution was not preserved")
	}
}

func TestByteSpansAndUnknownWords(t *testing.T) {
	source := "printf '\u4e2d\u6587'\n. 'path with space.sh'\n\"$COMMAND\" \"$ARG\"\nprintf \"*.sh\" *.sh\n"
	result, err := parseRequest(requestFor("offsets.sh", source))
	if err != nil {
		t.Fatal(err)
	}
	for _, call := range result.Scripts[0].Calls {
		for _, word := range call.Arguments {
			if string([]byte(source)[word.Start:word.End]) != word.Raw {
				t.Fatal("word range was not the exact source byte span")
			}
		}
	}
	calls := result.Scripts[0].Calls
	if calls[1].Line != 2 || calls[1].Column != 1 || calls[2].Arguments[0].Literal != nil {
		t.Fatal("position or unresolved command identity was fabricated")
	}
	if calls[3].Arguments[1].Literal == nil || calls[3].Arguments[2].Literal != nil {
		t.Fatal("quoted and unquoted glob words were not distinguished")
	}
}

func TestSingletonBracketCommandIsLiteral(t *testing.T) {
	source := "[ -n \"$VALUE\" ]\n'[' -n value ']'\n\"[\" -n value \"]\"\nprintf [\n"
	result, err := parseRequest(requestFor("bracket.sh", source))
	if err != nil {
		t.Fatal(err)
	}
	calls := result.Scripts[0].Calls
	if len(calls) != 4 {
		t.Fatalf("got %d calls, want 4", len(calls))
	}
	for index := range 3 {
		command := calls[index].Arguments[0]
		if command.Literal == nil || *command.Literal != "[" {
			t.Fatalf("call %d lost the exact bracket command: %#v", index, command)
		}
	}
	if calls[0].Arguments[2].Literal != nil || calls[3].Arguments[1].Literal != nil {
		t.Fatal("command-position exception resolved a variable or non-command bracket")
	}
}

func TestBracketCommandExceptionDoesNotResolvePatternsOrExpansions(t *testing.T) {
	source := "[ab] value\n[\"a\"] value\n[\"$SUFFIX\" value\n[${SUFFIX}] value\n* value\n? value\n{printf,echo} value\n~user/command value\n\"$COMMAND\" value\n"
	result, err := parseRequest(requestFor("patterns.sh", source))
	if err != nil {
		t.Fatal(err)
	}
	calls := result.Scripts[0].Calls
	if len(calls) != 9 {
		t.Fatalf("got %d calls, want 9", len(calls))
	}
	for _, call := range calls {
		command := call.Arguments[0]
		if command.Literal != nil {
			t.Fatalf("pattern or expansion was resolved as %q: %s", *command.Literal, command.Raw)
		}
	}
}

func TestParserNeverEvaluatesShell(t *testing.T) {
	root := t.TempDir()
	marker := filepath.Join(root, "must-not-exist")
	source := "touch '" + marker + "'\nsource <(touch '" + marker + "')\neval \"touch '" + marker + "'\"\n"
	if _, err := parseRequest(requestFor("untrusted.sh", source)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("shell input was evaluated")
	}
}

func TestRejectedInput(t *testing.T) {
	for name, input := range map[string]request{
		"syntax":    requestFor("broken.sh", "if then\n"),
		"version":   {SchemaVersion: 2, Scripts: requestFor("x", ":").Scripts},
		"empty":     {SchemaVersion: 1},
		"alias":     requestFor("../outside.sh", ":"),
		"duplicate": {SchemaVersion: 1, Scripts: []scriptInput{{Path: "a.sh", BytesBase64: "Og=="}, {Path: "A.sh", BytesBase64: "Og=="}}},
		"base64":    {SchemaVersion: 1, Scripts: []scriptInput{{Path: "a.sh", BytesBase64: "Og==\n"}}},
		"utf8":      {SchemaVersion: 1, Scripts: []scriptInput{{Path: "a.sh", BytesBase64: "/w=="}}},
		"large":     requestFor("a.sh", strings.Repeat("#", maxScriptBytes+1)),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseRequest(input); err == nil {
				t.Fatal("invalid input accepted")
			}
		})
	}
}

func TestStrictProtocol(t *testing.T) {
	valid, _ := json.Marshal(requestFor("empty.sh", "# comment only\n"))
	for name, raw := range map[string]string{
		"unknown":  `{"schemaVersion":1,"scripts":[],"extra":true}`,
		"trailing": string(valid) + " {}",
		"oversize": strings.Repeat(" ", maxProtocolBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeRequest(strings.NewReader(raw)); err == nil {
				t.Fatal("invalid protocol accepted")
			}
		})
	}
	input, err := decodeRequest(strings.NewReader(string(valid)))
	if err != nil {
		t.Fatal(err)
	}
	result, err := parseRequest(input)
	if err != nil || len(result.Scripts) != 1 || result.Scripts[0].Calls == nil || len(result.Scripts[0].Calls) != 0 {
		t.Fatalf("comment-only script must have an explicit empty call array: %v", err)
	}
}
