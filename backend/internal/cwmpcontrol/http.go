package cwmpcontrol

import (
	"context"
	"net/http"
	"time"
)

func pausedResponse(w http.ResponseWriter) {
	w.Header().Del("Content-Type")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Retry-After", "60")
	http.Error(w, ErrPaused.Error(), http.StatusServiceUnavailable)
}

func (c *Controller) Handler(next http.Handler) http.Handler {
	if c == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		ctx, release, err := c.Bind(req.Context())
		if err != nil {
			pausedResponse(w)
			return
		}
		defer release()
		stop := context.AfterFunc(ctx, func() {
			// Interrupt a slow SOAP upload as well as application/DB work.
			_ = http.NewResponseController(w).SetReadDeadline(time.Now())
			if req.Body != nil {
				_ = req.Body.Close()
			}
		})
		defer stop()
		gate := &responseGate{ResponseWriter: w, control: c, ctx: ctx}
		next.ServeHTTP(gate, req.WithContext(ctx))
		if !gate.written {
			gate.WriteHeader(http.StatusOK)
		}
	})
}

type responseGate struct {
	http.ResponseWriter
	control *Controller
	ctx     context.Context
	written bool
	blocked bool
}

func (w *responseGate) WriteHeader(status int) {
	if w.written {
		return
	}
	w.written = true
	if w.control.Check(w.ctx) != nil {
		w.blocked = true
		pausedResponse(w.ResponseWriter)
		return
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseGate) Write(value []byte) (int, error) {
	if !w.written {
		w.WriteHeader(http.StatusOK)
	}
	if w.blocked {
		return len(value), nil
	}
	return w.ResponseWriter.Write(value)
}
