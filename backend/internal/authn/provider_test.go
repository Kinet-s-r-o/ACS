package authn

import (
	"context"
	"errors"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

type testProvider struct{ called *int }

func (testProvider) Name() string { return "future-module" }
func (p testProvider) Authenticate(context.Context, Identity, string) error {
	*p.called++
	return ErrDenied
}

func TestProviderSelectionNeverFallsBack(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("local-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	identity := Identity{Username: "operator", PasswordHash: string(hash)}
	called := 0
	r := NewRegistry(testProvider{called: &called})
	if err := r.Authenticate(t.Context(), "", identity, "local-password"); err != nil {
		t.Fatal(err)
	}
	if err := r.Authenticate(t.Context(), "future-module", identity, "local-password"); !errors.Is(err, ErrDenied) || called != 1 {
		t.Fatal("module rejection fell back to local authentication")
	}
	if err := r.Authenticate(t.Context(), "missing", identity, "local-password"); !errors.Is(err, ErrUnavailable) {
		t.Fatal("unknown module did not fail closed")
	}
}
