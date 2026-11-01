package api

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

const deviceReachabilityTimeout = 2 * time.Second

var devicePingSequence atomic.Uint32

type deviceReachabilityResult struct {
	Status         string    `json:"status"`
	IPAddress      string    `json:"ip_address,omitempty"`
	CheckedAt      time.Time `json:"checked_at"`
	ResponseTimeMS float64   `json:"response_time_ms,omitempty"`
}

func (r *Router) handleDeviceReachability(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	serial := req.PathValue("serial")
	device, err := r.parseDeviceBySerial(req)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to get device")
		return
	}
	if device == nil {
		respondError(w, http.StatusNotFound, "Device not found")
		return
	}
	if !r.pingLimiter.Allow(serial) {
		w.Header().Set("Retry-After", "5")
		respondError(w, http.StatusTooManyRequests, "Wait before checking this device again")
		return
	}

	result := deviceReachabilityResult{Status: "unknown", CheckedAt: time.Now().UTC()}
	if device.IPAddress == nil || strings.TrimSpace(*device.IPAddress) == "" {
		respondJSON(w, http.StatusOK, result)
		return
	}
	result.IPAddress = strings.TrimSpace(*device.IPAddress)
	ip := net.ParseIP(result.IPAddress)
	if ip == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() || ip.Equal(net.IPv4bcast) {
		respondJSON(w, http.StatusOK, result)
		return
	}

	ctx, cancel := context.WithTimeout(req.Context(), deviceReachabilityTimeout)
	defer cancel()
	started := time.Now()
	reachable, err := pingDeviceIP(ctx, ip)
	if req.Context().Err() != nil {
		return
	}
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, "ACS could not perform an ICMP check")
		return
	}
	result.CheckedAt = time.Now().UTC()
	if reachable {
		result.Status = "reachable"
		result.ResponseTimeMS = float64(time.Since(started).Microseconds()) / 1000
	} else {
		result.Status = "unreachable"
	}
	respondJSON(w, http.StatusOK, result)
}

func pingDeviceIP(ctx context.Context, ip net.IP) (bool, error) {
	network, localAddress, protocol := "udp4", "0.0.0.0", 1
	var requestType icmp.Type = ipv4.ICMPTypeEcho
	var replyType icmp.Type = ipv4.ICMPTypeEchoReply
	if ip.To4() == nil {
		network, localAddress, protocol = "udp6", "::", 58
		requestType, replyType = ipv6.ICMPTypeEchoRequest, ipv6.ICMPTypeEchoReply
		ip = ip.To16()
	} else {
		ip = ip.To4()
	}

	conn, err := icmp.ListenPacket(network, localAddress)
	if err != nil {
		return false, err
	}
	defer conn.Close()

	deadline := time.Now().Add(deviceReachabilityTimeout)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return false, err
	}
	stopCancel := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
	defer stopCancel()

	identifier := os.Getpid() & 0xffff
	sequence := int(devicePingSequence.Add(1) & 0xffff)
	payload := []byte(fmt.Sprintf("acs:%x:%x", identifier, sequence))
	request := icmp.Message{
		Type: requestType,
		Code: 0,
		Body: &icmp.Echo{ID: identifier, Seq: sequence, Data: payload},
	}
	packet, err := request.Marshal(nil)
	if err != nil {
		return false, err
	}
	if _, err := conn.WriteTo(packet, &net.UDPAddr{IP: ip}); err != nil {
		return false, err
	}

	buffer := make([]byte, 1500)
	for {
		n, source, err := conn.ReadFrom(buffer)
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				return false, nil
			}
			return false, err
		}
		if !icmpSourceMatches(source, ip) {
			continue
		}
		message, err := icmp.ParseMessage(protocol, buffer[:n])
		if err != nil || message.Type != replyType {
			continue
		}
		echo, ok := message.Body.(*icmp.Echo)
		if ok && echo.Seq == sequence && string(echo.Data) == string(payload) {
			return true, nil
		}
	}
}

func icmpSourceMatches(source net.Addr, target net.IP) bool {
	switch address := source.(type) {
	case *net.IPAddr:
		return address.IP.Equal(target)
	case *net.UDPAddr:
		return address.IP.Equal(target)
	default:
		return false
	}
}
