package auth

import (
	"context"
	"github.com/matrix8412/acs/internal/models"
	"testing"
)

func TestInventoryFullCannotRevealIndependentCPESecrets(t *testing.T) {
	ctx := context.WithValue(context.Background(), UserContextKey, &Claims{Role: models.RoleRead})
	ctx = context.WithValue(ctx, PermissionsContextKey, []string{"access.inventory.full"})
	ctx = WithOperation(ctx, "inventory", "read")
	if CanReadSensitive(ctx) {
		t.Fatal("inventory Full revealed CPE secrets")
	}
	ctx = context.WithValue(ctx, PermissionsContextKey, []string{"access.inventory.full", "access.cpe.full"})
	if !CanReadSensitive(ctx) {
		t.Fatal("CPE Full could not read its own secrets")
	}
}
