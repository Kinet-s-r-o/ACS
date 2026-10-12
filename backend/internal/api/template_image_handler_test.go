package api

import (
	"path/filepath"
	"testing"
)

func TestDetectTemplateImageType(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want string
	}{
		{name: "jpeg", data: []byte{0xff, 0xd8, 0xff, 0xe0}, want: "image/jpeg"},
		{name: "png", data: []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}, want: "image/png"},
		{name: "gif", data: []byte("GIF89a"), want: "image/gif"},
		{name: "webp", data: []byte("RIFFxxxxWEBP"), want: "image/webp"},
		{name: "invalid", data: []byte("not an image")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, _ := detectTemplateImageType(test.data)
			if got != test.want {
				t.Fatalf("detectTemplateImageType() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestSecureTemplateImagePath(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "template.jpg")
	if got, err := secureTemplateImagePath(root, inside); err != nil || got != inside {
		t.Fatalf("secureTemplateImagePath() = %q, %v; want %q, nil", got, err, inside)
	}
	if _, err := secureTemplateImagePath(root, filepath.Join(root, "..", "secret")); err == nil {
		t.Fatal("secureTemplateImagePath() accepted a path outside the upload root")
	}
}
