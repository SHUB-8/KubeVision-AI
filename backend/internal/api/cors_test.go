package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCorsMiddleware_LocalhostOrigins(t *testing.T) {
	gin.SetMode(gin.TestMode)
	_ = os.Unsetenv("CORS_ALLOWED_ORIGINS")

	router := gin.New()
	router.Use(corsMiddleware(nil))
	router.GET("/test", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	tests := []struct {
		origin         string
		expectedAllow  bool
		expectedStatus int
	}{
		{"http://localhost:5173", true, http.StatusOK},
		{"http://127.0.0.1:8090", true, http.StatusOK},
		{"http://malicious.site.com", false, http.StatusForbidden},
	}

	for _, tc := range tests {
		req, _ := http.NewRequest(http.MethodOptions, "/test", nil)
		req.Header.Set("Origin", tc.origin)
		req.Header.Set("Access-Control-Request-Method", "GET")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if tc.expectedAllow {
			if w.Code != http.StatusNoContent && w.Code != http.StatusOK {
				t.Errorf("origin %s: expected 204 or 200, got %d", tc.origin, w.Code)
			}
			if allowOrigin := w.Header().Get("Access-Control-Allow-Origin"); allowOrigin != tc.origin {
				t.Errorf("origin %s: expected allow-origin %s, got %s", tc.origin, tc.origin, allowOrigin)
			}
		} else {
			if w.Code != http.StatusForbidden {
				t.Errorf("origin %s: expected 403 Forbidden, got %d", tc.origin, w.Code)
			}
		}
	}
}
