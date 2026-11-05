package auth

import (
	"context"
	"github.com/matrix8412/acs/internal/models"
)

type operationKey struct{}
type Operation struct{ Section, Action string }

// WithOperation is installed only after the server's route policy has authorized it.
func WithOperation(ctx context.Context, section, action string) context.Context {
	return context.WithValue(ctx, operationKey{}, Operation{section, action})
}
func GetOperation(ctx context.Context) (Operation, bool) {
	op, ok := ctx.Value(operationKey{}).(Operation)
	return op, ok
}
func OperationAuthorized(ctx context.Context) bool { _, ok := GetOperation(ctx); return ok }
func HasOperationAccess(ctx context.Context) bool {
	if OperationAuthorized(ctx) {
		return true
	}
	claims := GetUserFromContext(ctx)
	return claims != nil && claims.Role == models.RoleFull
}
func CanReadSensitive(ctx context.Context) bool {
	if user := GetUserFromContext(ctx); user != nil && user.Role == models.RoleFull {
		return true
	}
	if op, ok := GetOperation(ctx); ok {
		return models.HasSectionPermission(GetPermissionsFromContext(ctx), op.Section, "full")
	}
	claims := GetUserFromContext(ctx)
	return claims != nil && claims.Role == models.RoleFull
}
