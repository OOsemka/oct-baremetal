package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// The HTTP port (published by the image-cache Route) must not expose the API.
func TestHTTPPortServesOnlyImagesAndHealth(t *testing.T) {
	cache := &ImageCacheManager{cacheDir: t.TempDir(), images: map[string]*CachedImage{}}
	h := newImageMux(cache)
	check := func(method, path string, want ...int) {
		r := httptest.NewRequest(method, path, strings.NewReader("{}"))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		for _, c := range want {
			if w.Code == c {
				return
			}
		}
		t.Errorf("%s %s: got %d, want one of %v", method, path, w.Code, want)
	}
	check("GET", "/healthz", 200)
	check("GET", "/api/v1/image-cache/images/missing.qcow2", 404)
	for _, p := range []struct{ m, path string }{
		{"POST", "/api/v1/discover"}, {"POST", "/api/v1/log"}, {"POST", "/api/v1/image-cache/prepare"},
		{"GET", "/api/v1/image-cache/list"}, {"GET", "/api/v1/image-cache/status/x"}, {"DELETE", "/api/v1/image-cache/x"},
	} {
		check(p.m, p.path, 404, 405)
	}
}
