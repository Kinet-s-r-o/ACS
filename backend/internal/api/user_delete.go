package api

import (
	"errors"
	"github.com/matrix8412/acs/internal/auth"
	"github.com/matrix8412/acs/internal/database"
	"github.com/matrix8412/acs/internal/models"
	"gorm.io/gorm"
	"net/http"
	"strconv"
)

var errDeleteBroaderUser = errors.New("Cannot delete a user with broader permissions")

func (r *Router) handleDeleteUser(w http.ResponseWriter, req *http.Request) {
	claims := auth.GetUserFromContext(req.Context())
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		respondError(w, http.StatusBadRequest, "Invalid user ID")
		return
	}
	if claims == nil || id == claims.UserID {
		respondError(w, http.StatusBadRequest, "Cannot delete your own account")
		return
	}
	check := func(tx *gorm.DB, target *models.User) error {
		scoped := *r
		scoped.roleRepo = database.NewRoleRepository(tx)
		if !scoped.canManageUser(req, target) {
			return errDeleteBroaderUser
		}
		return nil
	}
	if err := r.userRepo.DeleteChecked(req.Context(), id, check); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			respondError(w, http.StatusNotFound, "User not found")
		} else if errors.Is(err, errDeleteBroaderUser) {
			respondError(w, http.StatusForbidden, err.Error())
		} else if errors.Is(err, database.ErrLastFullAdmin) || errors.Is(err, database.ErrLastLocalAdmin) {
			respondError(w, http.StatusBadRequest, err.Error())
		} else {
			respondError(w, http.StatusInternalServerError, "Could not delete user")
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
