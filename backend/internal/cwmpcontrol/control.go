package cwmpcontrol

import (
	"context"
	"errors"
	"sync"
	"time"
)

var ErrPaused = errors.New("CWMP communication is paused")

type State struct {
	Enabled   bool       `json:"enabled"`
	UpdatedAt *time.Time `json:"updated_at,omitempty"`
	UpdatedBy string     `json:"updated_by,omitempty"`
}

type Store interface {
	Load(context.Context) (State, error)
	Save(context.Context, State) error
}

type Controller struct {
	mu      sync.RWMutex
	store   Store
	state   State
	epoch   uint64
	running context.Context
	cancel  context.CancelFunc
	onPause []func()
}

func New(ctx context.Context, store Store) (*Controller, error) {
	state, err := store.Load(ctx)
	if err != nil {
		return nil, err
	}
	running, cancel := context.WithCancel(context.Background())
	if !state.Enabled {
		cancel()
	}
	return &Controller{store: store, state: state, running: running, cancel: cancel}, nil
}

func (c *Controller) Snapshot() State {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.state
}

func (c *Controller) Enabled() bool {
	if c == nil {
		return true
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.state.Enabled
}

func (c *Controller) OnPause(callback func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onPause = append(c.onPause, callback)
	if !c.state.Enabled {
		callback()
	}
}

func (c *Controller) Set(ctx context.Context, enabled bool, user string) (State, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state.Enabled == enabled {
		return c.state, nil
	}
	now := time.Now().UTC()
	state := State{Enabled: enabled, UpdatedAt: &now, UpdatedBy: user}
	if err := c.store.Save(ctx, state); err != nil {
		return c.state, err
	}
	c.cancel()
	c.running, c.cancel = context.WithCancel(context.Background())
	c.epoch++
	c.state = state
	if !enabled {
		c.cancel()
		for _, callback := range c.onPause {
			callback()
		}
	}
	return state, nil
}

type epochKey struct{}

// Bind cancels in-flight work on state changes; Check also rejects an old
// request after a rapid off/on cycle before cancellation callbacks have run.
func (c *Controller) Bind(parent context.Context) (context.Context, context.CancelFunc, error) {
	if c == nil {
		return parent, func() {}, nil
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	if !c.state.Enabled {
		return nil, nil, ErrPaused
	}
	ctx, cancel := context.WithCancelCause(context.WithValue(parent, epochKey{}, c.epoch))
	stop := context.AfterFunc(c.running, func() { cancel(ErrPaused) })
	return ctx, func() { stop(); cancel(context.Canceled) }, nil
}

func (c *Controller) Check(ctx context.Context) error {
	if c == nil {
		return nil
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	epoch, bound := ctx.Value(epochKey{}).(uint64)
	if !c.state.Enabled || (bound && epoch != c.epoch) {
		return ErrPaused
	}
	return context.Cause(ctx)
}
