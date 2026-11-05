package authn

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"layeh.com/radius"
	"layeh.com/radius/rfc2865"
	"layeh.com/radius/rfc2869"
)

const testRadiusSecret = "test-only-shared-secret-32-bytes"

func testRadiusResponse(t *testing.T, wire, secret []byte, code radius.Code, mode string) []byte {
	t.Helper()
	request, err := radius.Parse(wire, secret)
	if err != nil {
		t.Error(err)
		return nil
	}
	reply := request.Response(code)
	if mode != "missing-ma" {
		if err := rfc2869.MessageAuthenticator_Set(reply, make([]byte, 16)); err != nil {
			t.Error(err)
			return nil
		}
		unsigned, err := reply.MarshalBinary()
		if err != nil {
			t.Error(err)
			return nil
		}
		mac := hmac.New(md5.New, secret)
		_, _ = mac.Write(unsigned)
		signature := mac.Sum(nil)
		if mode == "invalid-ma" {
			signature[0] ^= 1
		}
		if err := rfc2869.MessageAuthenticator_Set(reply, signature); err != nil {
			t.Error(err)
			return nil
		}
	}
	encoded, err := reply.Encode()
	if err != nil {
		t.Error(err)
		return nil
	}
	return encoded
}

func serveTestUDP(t *testing.T, code radius.Code, mode string) (RadiusServer, *atomic.Int32) {
	t.Helper()
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	count := &atomic.Int32{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			buffer := make([]byte, 4096)
			n, address, err := conn.ReadFrom(buffer)
			if err != nil {
				return
			}
			count.Add(1)
			wire := buffer[:n]
			if mode == "timeout" {
				continue
			}
			p, err := radius.Parse(wire, []byte(testRadiusSecret))
			if err != nil {
				t.Error(err)
				return
			}
			if rfc2865.UserName_GetString(p) != "operator" || rfc2865.UserPassword_GetString(p) != "password" {
				t.Error("wrong RADIUS credentials")
			}
			signature := append([]byte(nil), wire[len(wire)-16:]...)
			unsigned := append([]byte(nil), wire...)
			clear(unsigned[len(unsigned)-16:])
			mac := hmac.New(md5.New, []byte(testRadiusSecret))
			_, _ = mac.Write(unsigned)
			if !hmac.Equal(signature, mac.Sum(nil)) {
				t.Error("invalid request Message-Authenticator")
			}
			_, _ = conn.WriteTo(testRadiusResponse(t, wire, []byte(testRadiusSecret), code, mode), address)
		}
	}()
	t.Cleanup(func() { _ = conn.Close(); <-done })
	return RadiusServer{ID: conn.LocalAddr().String(), Address: conn.LocalAddr().String(), Transport: "udp", Secret: testRadiusSecret, TimeoutSeconds: 1, Attempts: 1}, count
}

func TestRadiusUDPAndFailover(t *testing.T) {
	for _, tc := range []struct {
		name string
		code radius.Code
		mode string
		want error
	}{
		{"accept", radius.CodeAccessAccept, "", nil},
		{"reject", radius.CodeAccessReject, "", ErrDenied},
		{"challenge", radius.CodeAccessChallenge, "", ErrChallengeUnsupported},
		{"missing-integrity", radius.CodeAccessAccept, "missing-ma", ErrUnavailable},
		{"forged-integrity", radius.CodeAccessAccept, "invalid-ma", ErrUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			first, _ := serveTestUDP(t, tc.code, tc.mode)
			backup, backupCount := serveTestUDP(t, radius.CodeAccessAccept, "")
			config := RadiusConfig{Enabled: true, NASIdentifier: "ACS", Servers: []RadiusServer{first, backup}}
			if err := config.Authenticate(t.Context(), "operator", "password"); !errors.Is(err, tc.want) {
				t.Fatalf("got %v; want %v", err, tc.want)
			}
			if backupCount.Load() != 0 {
				t.Fatal("valid decision or invalid response triggered failover")
			}
		})
	}
	t.Run("network-failover", func(t *testing.T) {
		first, firstCount := serveTestUDP(t, radius.CodeAccessAccept, "timeout")
		first.Attempts = 2
		backup, backupCount := serveTestUDP(t, radius.CodeAccessAccept, "")
		config := RadiusConfig{Enabled: true, Servers: []RadiusServer{first, backup}}
		if err := config.Authenticate(t.Context(), "operator", "password"); err != nil {
			t.Fatal(err)
		}
		if firstCount.Load() != 2 || backupCount.Load() != 1 {
			t.Fatal("wrong retry or server order")
		}
	})
	t.Run("cancel", func(t *testing.T) {
		server, _ := serveTestUDP(t, radius.CodeAccessAccept, "timeout")
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		if err := (RadiusConfig{Enabled: true, Servers: []RadiusServer{server}}).Authenticate(ctx, "operator", "password"); !errors.Is(err, ErrUnavailable) {
			t.Fatal(err)
		}
	})
}

func testTLSMaterial(t *testing.T) (tls.Certificate, string, string, string) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "radius.test"}, DNSNames: []string{"radius.test"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	keyPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))
	cert, err := tls.X509KeyPair([]byte(certPEM), []byte(keyPEM))
	if err != nil {
		t.Fatal(err)
	}
	return cert, certPEM, certPEM, keyPEM
}

func TestRadiusMutualTLSFramingAndCertificateValidation(t *testing.T) {
	cert, ca, clientCert, clientKey := testTLSMaterial(t)
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM([]byte(ca))
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: pool})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
			header := make([]byte, 4)
			if _, err := io.ReadFull(conn, header); err == nil {
				length := int(binary.BigEndian.Uint16(header[2:4]))
				if length >= 20 && length <= 4096 {
					request := make([]byte, length)
					copy(request, header)
					if _, err := io.ReadFull(conn, request[4:]); err == nil {
						p, err := radius.Parse(request, []byte("radsec"))
						if err != nil || rfc2865.UserPassword_GetString(p) != "password" {
							t.Error("RadSec must use the RFC 6614 secret")
						}
						reply := testRadiusResponse(t, request, []byte("radsec"), radius.CodeAccessAccept, "")
						// Force multiple TLS records; TCP reads cannot assume datagram framing.
						_, _ = conn.Write(reply[:3])
						_, _ = conn.Write(reply[3:])
					}
				}
			}
			_ = conn.Close()
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); <-done })
	server := RadiusServer{ID: "tls", Address: listener.Addr().String(), Transport: "tls", TimeoutSeconds: 1, Attempts: 1, ServerName: "radius.test", CAPEM: ca, ClientCertPEM: clientCert, ClientKeyPEM: clientKey}
	backup, calls := serveTestUDP(t, radius.CodeAccessAccept, "")
	config := RadiusConfig{Enabled: true, Servers: []RadiusServer{server, backup}}
	if err := config.Authenticate(t.Context(), "operator", "password"); err != nil {
		t.Fatal(err)
	}
	config.Servers[0].ServerName = "wrong.test"
	if err := config.Authenticate(t.Context(), "operator", "password"); !errors.Is(err, ErrUnavailable) {
		t.Fatal("untrusted certificate accepted")
	}
	if calls.Load() != 0 {
		t.Fatal("TLS certificate failure downgraded to UDP")
	}
}

func TestRadiusSecretsAndValidation(t *testing.T) {
	previous := RadiusConfig{Servers: []RadiusServer{{ID: "a", Secret: "secret-a", ClientKeyPEM: "key-a"}, {ID: "b", Secret: "secret-b"}}}
	redacted := previous.Redacted()
	if redacted.Servers[0].Secret != "" || redacted.Servers[0].ClientKeyPEM != "" || previous.Servers[0].Secret == "" {
		t.Fatal("redaction leaked or mutated secrets")
	}
	next := RadiusConfig{Servers: []RadiusServer{redacted.Servers[1], redacted.Servers[0]}}
	next.PreserveSecrets(previous)
	if next.Servers[0].Secret != "secret-b" || next.Servers[1].ClientKeyPEM != "key-a" {
		t.Fatal("secrets followed row position instead of server identity")
	}
	for _, c := range []RadiusConfig{
		{Enabled: true},
		{Servers: []RadiusServer{{ID: "a", Address: "localhost:1812", Transport: "udp", Secret: "short", Attempts: 1, TimeoutSeconds: 1}}},
		{Servers: []RadiusServer{{ID: "a", Address: "localhost:2083", Transport: "tls", CAPEM: "invalid", Attempts: 1, TimeoutSeconds: 1}}},
	} {
		if c.Validate() == nil {
			t.Fatal("invalid configuration accepted")
		}
	}
}
