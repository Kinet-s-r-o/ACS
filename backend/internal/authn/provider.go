// Package authn verifies credentials independently of ACS authorization and sessions.
package authn

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/matrix8412/acs/internal/auth"
)

var (
	ErrDenied               = errors.New("invalid credentials")
	ErrUnavailable          = errors.New("authentication service unavailable")
	ErrChallengeUnsupported = errors.New("RADIUS challenge requires a supported MFA flow; use ACS TOTP")
)

type Identity struct {
	Username     string
	PasswordHash string
}

type Provider interface {
	Name() string
	Authenticate(context.Context, Identity, string) error
}

// Registry is immutable after construction; a failed module never falls back to another.
type Registry struct{ providers map[string]Provider }

func NewRegistry(providers ...Provider) *Registry {
	r := &Registry{providers: map[string]Provider{"local": Local{}}}
	for _, provider := range providers {
		if provider.Name() == "" || r.providers[provider.Name()] != nil {
			panic("duplicate authentication provider")
		}
		r.providers[provider.Name()] = provider
	}
	return r
}

func (r *Registry) Supports(name string) bool { return r.providers[Normalize(name)] != nil }

func (r *Registry) Names() []string {
	names := make([]string, 0, len(r.providers))
	for name := range r.providers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (r *Registry) Authenticate(ctx context.Context, name string, identity Identity, password string) error {
	p := r.providers[Normalize(name)]
	if p == nil {
		return ErrUnavailable
	}
	if password == "" {
		return ErrDenied
	}
	return p.Authenticate(ctx, identity, password)
}

func Normalize(name string) string {
	if name == "" {
		return "local"
	}
	return name
}

type Local struct{}

func (Local) Name() string { return "local" }
func (Local) Authenticate(_ context.Context, identity Identity, password string) error {
	if !auth.CheckPassword(password, identity.PasswordHash) {
		return ErrDenied
	}
	return nil
}

func unavailable(err error) error { return fmt.Errorf("%w: %w", ErrUnavailable, err) }
