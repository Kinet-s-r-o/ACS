package api

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/skydashnet/skyacs/internal/models"
)

func (r *Router) templateImageURL(template *models.ProvisioningTemplate) {
	if template.ImagePath != "" {
		template.ImageURL = "/provisioning/templates/" + strconv.FormatInt(template.ID, 10) + "/image"
	} else {
		template.ImageURL = ""
	}
}

func (r *Router) handleGetProvisioningTemplateImage(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	template, err := r.provisioningRepo.GetTemplate(req.Context(), id)
	if err != nil || template.ImagePath == "" {
		respondError(w, http.StatusNotFound, "Template image not found")
		return
	}
	imagePath, err := secureTemplateImagePath(r.templateImageDir, template.ImagePath)
	if err != nil {
		respondError(w, http.StatusNotFound, "Template image not found")
		return
	}
	file, err := os.Open(imagePath)
	if err != nil {
		respondError(w, http.StatusNotFound, "Template image not found")
		return
	}
	defer file.Close()

	contentType := template.ImageType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, no-store")
	stat, err := file.Stat()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to read template image")
		return
	}
	http.ServeContent(w, req, filepath.Base(imagePath), stat.ModTime(), file)
}

func (r *Router) handleUploadProvisioningTemplateImage(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	template, err := r.provisioningRepo.GetTemplate(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "Template not found")
		return
	}
	if r.templateImageInitErr != nil {
		respondError(w, http.StatusServiceUnavailable, "Template image storage unavailable")
		return
	}
	if err := req.ParseMultipartForm(maxTemplateImageSize); err != nil {
		respondError(w, http.StatusBadRequest, "Image is too large or the form is invalid")
		return
	}
	file, _, err := req.FormFile("file")
	if err != nil {
		respondError(w, http.StatusBadRequest, "No image uploaded")
		return
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, maxTemplateImageSize+1))
	if err != nil || len(data) == 0 {
		respondError(w, http.StatusBadRequest, "Failed to read image")
		return
	}
	if len(data) > maxTemplateImageSize {
		respondError(w, http.StatusBadRequest, "Image exceeds the 5 MB limit")
		return
	}
	contentType, extension := detectTemplateImageType(data)
	if contentType == "" {
		respondError(w, http.StatusBadRequest, "Unsupported image type; use JPEG, PNG, GIF, or WebP")
		return
	}

	tempFile, err := os.CreateTemp(r.templateImageDir, ".template-image-*")
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to save image")
		return
	}
	tempPath := tempFile.Name()
	defer os.Remove(tempPath)
	if _, err := tempFile.Write(data); err != nil {
		_ = tempFile.Close()
		respondError(w, http.StatusInternalServerError, "Failed to save image")
		return
	}
	if err := tempFile.Close(); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to save image")
		return
	}
	if err := os.Chmod(tempPath, 0600); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to secure image")
		return
	}
	imagePath := filepath.Join(r.templateImageDir, strconv.FormatInt(id, 10)+"-"+strconv.FormatInt(time.Now().UnixNano(), 10)+extension)
	if err := os.Rename(tempPath, imagePath); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to finalize image")
		return
	}
	if err := r.provisioningRepo.UpdateTemplateImage(req.Context(), id, imagePath, contentType); err != nil {
		_ = os.Remove(imagePath)
		respondError(w, http.StatusInternalServerError, "Failed to save template image")
		return
	}
	if template.ImagePath != "" {
		if oldPath, pathErr := secureTemplateImagePath(r.templateImageDir, template.ImagePath); pathErr == nil {
			_ = os.Remove(oldPath)
		}
	}
	template.ImagePath, template.ImageType = imagePath, contentType
	r.templateImageURL(template)
	redactProvisioningVariableSecrets(template.Variables)
	respondJSON(w, http.StatusOK, template)
}

func (r *Router) handleDeleteProvisioningTemplateImage(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(req.PathValue("id"), 10, 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Invalid template ID")
		return
	}
	template, err := r.provisioningRepo.GetTemplate(req.Context(), id)
	if err != nil {
		respondError(w, http.StatusNotFound, "Template not found")
		return
	}
	if err := r.provisioningRepo.ClearTemplateImage(req.Context(), id); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to remove template image")
		return
	}
	if template.ImagePath != "" {
		if imagePath, pathErr := secureTemplateImagePath(r.templateImageDir, template.ImagePath); pathErr == nil {
			_ = os.Remove(imagePath)
		}
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func detectTemplateImageType(data []byte) (string, string) {
	switch {
	case len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
		return "image/jpeg", ".jpg"
	case len(data) >= 8 && bytes.Equal(data[:8], []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}):
		return "image/png", ".png"
	case len(data) >= 6 && (string(data[:6]) == "GIF87a" || string(data[:6]) == "GIF89a"):
		return "image/gif", ".gif"
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return "image/webp", ".webp"
	default:
		return "", ""
	}
}

func secureTemplateImagePath(root, path string) (string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	pathAbs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(rootAbs, pathAbs)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", os.ErrPermission
	}
	return pathAbs, nil
}
