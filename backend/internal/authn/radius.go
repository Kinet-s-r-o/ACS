package authn

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5" // RADIUS protocol mandates HMAC-MD5; TLS provides transport protection.
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"layeh.com/radius"
	"layeh.com/radius/rfc2865"
	"layeh.com/radius/rfc2869"
)

type RadiusConfig struct {
	Enabled       bool           `json:"enabled"`
	NASIdentifier string         `json:"nas_identifier"`
	Servers       []RadiusServer `json:"servers"`
}

type RadiusServer struct {
	ID             string `json:"id"`
	Address        string `json:"address"`
	Transport      string `json:"transport"`
	TimeoutSeconds int    `json:"timeout_seconds"`
	Attempts       int    `json:"attempts"`
	Secret         string `json:"secret,omitempty"`
	SecretSet      bool   `json:"secret_set,omitempty"`
	ServerName     string `json:"server_name,omitempty"`
	CAPEM          string `json:"ca_pem,omitempty"`
	ClientCertPEM  string `json:"client_cert_pem,omitempty"`
	ClientKeyPEM   string `json:"client_key_pem,omitempty"`
	ClientKeySet   bool   `json:"client_key_set,omitempty"`
}

func (c RadiusConfig) Validate() error {
	if len(c.NASIdentifier) > 253 {
		return errors.New("NAS identifier must be at most 253 bytes")
	}
	if len(c.Servers) > 8 || (c.Enabled && len(c.Servers) == 0) {
		return errors.New("configure between 1 and 8 RADIUS servers")
	}
	ids := map[string]bool{}
	for i, s := range c.Servers {
		if s.ID == "" || len(s.ID) > 64 || ids[s.ID] {
			return errors.New("server IDs must be unique and at most 64 characters")
		}
		ids[s.ID] = true
		host, port, err := net.SplitHostPort(s.Address)
		if err != nil || strings.TrimSpace(host) == "" {
			return fmt.Errorf("server %d: address must be host:port", i+1)
		}
		p, err := strconv.Atoi(port)
		if err != nil || p < 1 || p > 65535 {
			return fmt.Errorf("server %d: invalid port", i+1)
		}
		if s.TimeoutSeconds < 1 || s.TimeoutSeconds > 10 || s.Attempts < 1 || s.Attempts > 2 {
			return errors.New("timeout must be 1-10 seconds and attempts 1-2")
		}
		switch s.Transport {
		case "udp":
			if len(s.Secret) < 16 || len(s.Secret) > 253 {
				return errors.New("UDP shared secret must contain 16-253 bytes")
			}
		case "tls":
			if _, err := s.tlsConfig(); err != nil {
				return fmt.Errorf("server %d: invalid TLS certificates or key", i+1)
			}
		default:
			return errors.New("transport must be udp or tls")
		}
	}
	return nil
}

func (s RadiusServer) tlsConfig() (*tls.Config, error) {
	host, _, err := net.SplitHostPort(s.Address)
	if err != nil {
		return nil, err
	}
	if s.ServerName != "" {
		host = s.ServerName
	}
	c := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: host}
	if s.CAPEM != "" {
		c.RootCAs = x509.NewCertPool()
		if !c.RootCAs.AppendCertsFromPEM([]byte(s.CAPEM)) {
			return nil, errors.New("invalid CA")
		}
	}
	if s.ClientCertPEM != "" || s.ClientKeyPEM != "" {
		cert, err := tls.X509KeyPair([]byte(s.ClientCertPEM), []byte(s.ClientKeyPEM))
		if err != nil {
			return nil, err
		}
		c.Certificates = []tls.Certificate{cert}
	}
	return c, nil
}

func (c RadiusConfig) Redacted() RadiusConfig {
	c.Servers = append([]RadiusServer{}, c.Servers...)
	for i := range c.Servers {
		s := &c.Servers[i]
		s.SecretSet, s.ClientKeySet = s.Secret != "", s.ClientKeyPEM != ""
		s.Secret, s.ClientKeyPEM = "", ""
	}
	return c
}

// Preserve secrets by stable server ID, never by the editable row's position.
func (c *RadiusConfig) PreserveSecrets(previous RadiusConfig) {
	for i := range c.Servers {
		for _, old := range previous.Servers {
			if old.ID != c.Servers[i].ID {
				continue
			}
			if c.Servers[i].Secret == "" && c.Servers[i].SecretSet {
				c.Servers[i].Secret = old.Secret
			}
			if c.Servers[i].ClientKeyPEM == "" && c.Servers[i].ClientKeySet {
				c.Servers[i].ClientKeyPEM = old.ClientKeyPEM
			}
		}
	}
}

type Radius struct {
	Load func(context.Context) (RadiusConfig, error)
}

func (Radius) Name() string { return "radius" }

func (r Radius) Authenticate(ctx context.Context, identity Identity, password string) error {
	c, err := r.Load(ctx)
	if err != nil || !c.Enabled {
		return ErrUnavailable
	}
	return c.Authenticate(ctx, identity.Username, password)
}

func (c RadiusConfig) Authenticate(ctx context.Context, username, password string) error {
	if err := c.Validate(); err != nil {
		return ErrUnavailable
	}
	if !c.Enabled {
		return ErrUnavailable
	}
	if username == "" || len(username) > 253 || password == "" || len(password) > 128 {
		return ErrDenied
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	for _, server := range c.Servers {
		for attempt := 0; attempt < server.Attempts; attempt++ {
			if ctx.Err() != nil {
				return ErrUnavailable
			}
			err := server.authenticate(ctx, c.NASIdentifier, username, password)
			var networkError *net.OpError
			// Only transport failures permit retries/failover. Rejects and invalid replies are final.
			if !errors.As(err, &networkError) {
				if err == nil || errors.Is(err, ErrDenied) || errors.Is(err, ErrChallengeUnsupported) {
					return err
				}
				return ErrUnavailable
			}
			var certError *tls.CertificateVerificationError
			if errors.As(err, &certError) {
				return ErrUnavailable
			}
		}
	}
	return ErrUnavailable
}

func (s RadiusServer) authenticate(ctx context.Context, nas, username, password string) error {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(s.TimeoutSeconds)*time.Second)
	defer cancel()
	secret := []byte(s.Secret)
	if s.Transport == "tls" {
		secret = []byte("radsec")
	} // RFC 6614, section 2.3.
	p := radius.New(radius.CodeAccessRequest, secret)
	if err := rfc2865.UserName_SetString(p, username); err != nil {
		return ErrDenied
	}
	if err := rfc2865.UserPassword_SetString(p, password); err != nil {
		return ErrDenied
	}
	if nas != "" {
		if err := rfc2865.NASIdentifier_SetString(p, nas); err != nil {
			return ErrUnavailable
		}
	}
	if err := rfc2865.ServiceType_Set(p, rfc2865.ServiceType_Value_AuthenticateOnly); err != nil {
		return ErrUnavailable
	}
	if err := rfc2869.MessageAuthenticator_Set(p, make([]byte, 16)); err != nil {
		return ErrUnavailable
	}
	wire, err := p.Encode()
	if err != nil {
		return ErrUnavailable
	}
	mac := hmac.New(md5.New, secret)
	_, _ = mac.Write(wire)
	if err := rfc2869.MessageAuthenticator_Set(p, mac.Sum(nil)); err != nil {
		return ErrUnavailable
	}
	wire, err = p.Encode()
	if err != nil {
		return ErrUnavailable
	}
	var conn net.Conn
	dialer := &net.Dialer{}
	if s.Transport == "tls" {
		config, configErr := s.tlsConfig()
		if configErr != nil {
			return ErrUnavailable
		}
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: config}).DialContext(ctx, "tcp", s.Address)
	} else {
		conn, err = dialer.DialContext(ctx, "udp", s.Address)
	}
	if err != nil {
		return err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return unavailable(err)
	}
	if _, err := io.Copy(conn, bytes.NewReader(wire)); err != nil {
		return err
	}
	var reply []byte
	if s.Transport == "tls" {
		header := make([]byte, 4)
		if _, err := io.ReadFull(conn, header); err != nil {
			return &net.OpError{Op: "read", Net: "tcp", Err: err}
		}
		length := int(binary.BigEndian.Uint16(header[2:4]))
		if length < 20 || length > radius.MaxPacketLength {
			return ErrUnavailable
		}
		reply = make([]byte, length)
		copy(reply, header)
		if _, err := io.ReadFull(conn, reply[4:]); err != nil {
			return &net.OpError{Op: "read", Net: "tcp", Err: err}
		}
	} else {
		reply = make([]byte, radius.MaxPacketLength+1)
		n, err := conn.Read(reply)
		if err != nil {
			return err
		}
		reply = reply[:n]
	}
	return verifyRadiusReply(reply, wire, secret)
}

func verifyRadiusReply(reply, request, secret []byte) error {
	if len(reply) < 20 || len(reply) > radius.MaxPacketLength || int(binary.BigEndian.Uint16(reply[2:4])) != len(reply) || reply[1] != request[1] {
		return ErrUnavailable
	}
	if !radius.IsAuthenticResponse(reply, request, secret) {
		return ErrUnavailable
	}
	// Require exactly one valid Message-Authenticator, including non-EAP exchanges (BlastRADIUS).
	unsigned := append([]byte(nil), reply...)
	copy(unsigned[4:20], request[4:20])
	var signature []byte
	for offset := 20; offset < len(reply); {
		if offset+2 > len(reply) {
			return ErrUnavailable
		}
		length := int(reply[offset+1])
		if length < 2 || offset+length > len(reply) {
			return ErrUnavailable
		}
		if reply[offset] == 80 {
			if signature != nil || length != 18 {
				return ErrUnavailable
			}
			signature = reply[offset+2 : offset+18]
			clear(unsigned[offset+2 : offset+18])
		}
		offset += length
	}
	mac := hmac.New(md5.New, secret)
	_, _ = mac.Write(unsigned)
	if signature == nil || !hmac.Equal(signature, mac.Sum(nil)) {
		return ErrUnavailable
	}
	switch radius.Code(reply[0]) {
	case radius.CodeAccessAccept:
		return nil
	case radius.CodeAccessReject:
		return ErrDenied
	case radius.CodeAccessChallenge:
		return ErrChallengeUnsupported
	default:
		return ErrUnavailable
	}
}
