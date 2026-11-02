package cwmp

import "testing"

func TestInformEventCodesPreservesOrderAndRemovesDuplicates(t *testing.T) {
	inform := &Inform{Event: EventList{Events: []EventStruct{
		{EventCode: "0 BOOTSTRAP"},
		{EventCode: "6 CONNECTION REQUEST"},
		{EventCode: "0 BOOTSTRAP"},
		{EventCode: "  "},
	}}}

	got := informEventCodes(inform)
	want := []string{"0 BOOTSTRAP", "6 CONNECTION REQUEST"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestInformEventCodesReturnsNilWithoutEvents(t *testing.T) {
	if got := informEventCodes(&Inform{}); got != nil {
		t.Fatalf("got %v, want nil", got)
	}
}

func TestInformHasEventCodeMatchesCodeToken(t *testing.T) {
	inform := &Inform{Event: EventList{Events: []EventStruct{
		{EventCode: "10 VALUE CHANGE"},
		{EventCode: "1 BOOT"},
	}}}
	if !informHasEventCode(inform, "1") {
		t.Fatal("expected BOOT event to be detected")
	}
	if informHasEventCode(inform, "0") {
		t.Fatal("did not expect code 0 to match event code 10")
	}
}
