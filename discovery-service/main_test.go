package main

import (
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OOsemka/oct-storefront/backend-security-kit/auth"
	"github.com/OOsemka/oct-storefront/backend-security-kit/kubeclient"
)

// fakeAPI answers SelfSubjectAccessReviews: token "admin" may do anything, "viewer"
// may only list baremetalhosts, anything else is rejected (401).
func fakeAPI(t *testing.T) *kubeclient.Client {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if tok != "admin" && tok != "viewer" {
			w.WriteHeader(401)
			return
		}
		var req struct {
			Spec struct {
				ResourceAttributes struct{ Verb, Resource string } `json:"resourceAttributes"`
			} `json:"spec"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		ra := req.Spec.ResourceAttributes
		allowed := tok == "admin" || (ra.Verb == "list" && ra.Resource == "baremetalhosts")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": map[string]any{"allowed": allowed}})
	}))
	t.Cleanup(srv.Close)
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("sa"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := kubeclient.New(srv.URL, ca, tokenFile)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func call(h http.Handler, method, path, token, body string) int {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code
}

func TestImagePortServesOnlyImagesAndHealth(t *testing.T) {
	cache := &ImageCacheManager{cacheDir: t.TempDir(), images: map[string]*CachedImage{}}
	h := imageMux(cache)
	if c := call(h, "GET", "/healthz", "", ""); c != 200 {
		t.Fatalf("healthz: %d", c)
	}
	for _, p := range []struct{ m, path string }{
		{"POST", "/api/v1/discover"}, {"POST", "/api/v1/log"}, {"POST", "/api/v1/image-cache/prepare"},
		{"GET", "/api/v1/image-cache/list"}, {"DELETE", "/api/v1/image-cache/x"},
	} {
		if c := call(h, p.m, p.path, "", "{}"); c != 404 && c != 405 {
			t.Errorf("%s %s on the image port: got %d, want 404/405", p.m, p.path, c)
		}
	}
}

func TestPermissionTable(t *testing.T) {
	cache := &ImageCacheManager{cacheDir: t.TempDir(), images: map[string]*CachedImage{}, allowedNamespaces: []string{defaultOSImagesNS}}
	authz, err := auth.New(auth.Options{Extension: extension, Mode: auth.Enforce, Client: fakeAPI(t)}, apiRoutes(cache))
	if err != nil {
		t.Fatalf("permission table: %v", err)
	}
	h := authz.Handler()
	cases := []struct {
		name, method, path, token, body string
		want                            int
	}{
		{"discover without token", "POST", "/api/v1/discover", "", `{"namespace":"team-a"}`, 401},
		{"discover without namespace", "POST", "/api/v1/discover", "admin", `{"bmcAddress":"x"}`, 400},
		{"discover as viewer", "POST", "/api/v1/discover", "viewer", `{"namespace":"team-a"}`, 403},
		{"list as viewer", "GET", "/api/v1/image-cache/list", "viewer", "", 200},
		{"delete as viewer", "DELETE", "/api/v1/image-cache/x", "viewer", "", 403},
		{"prepare as viewer", "POST", "/api/v1/image-cache/prepare", "viewer", `{"dataSourceName":"rhel9"}`, 403},
		{"prepare in kube-system (admin)", "POST", "/api/v1/image-cache/prepare", "admin", `{"dataSourceName":"rhel9","namespace":"kube-system"}`, 400},
		{"prepare with a bad name (admin)", "POST", "/api/v1/image-cache/prepare", "admin", `{"dataSourceName":"../x"}`, 400},
		{"image files are not on the API port", "GET", "/api/v1/image-cache/images/x.qcow2", "admin", "", 403},
	}
	for _, c := range cases {
		if got := call(h, c.method, c.path, c.token, c.body); got != c.want {
			t.Errorf("%s: got %d want %d", c.name, got, c.want)
		}
	}
}
