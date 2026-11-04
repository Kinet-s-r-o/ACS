package cwmp

import "github.com/matrix8412/acs/internal/cwmpcontrol"

func communicationControl(controls []*cwmpcontrol.Controller) *cwmpcontrol.Controller {
	if len(controls) > 0 {
		return controls[0]
	}
	return nil
}

func (h *Handler) ClearSessions() {
	h.sessions.mu.Lock()
	defer h.sessions.mu.Unlock()
	clear(h.sessions.sessions)
}
