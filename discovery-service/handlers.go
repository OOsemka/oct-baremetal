package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
)

type DiscoverRequest struct {
	BMCAddress string `json:"bmcAddress"`
	Username   string `json:"username"`
	Password   string `json:"password"`
}

type DiscoverResponse struct {
	Model            string          `json:"model"`
	Manufacturer     string          `json:"manufacturer"`
	SerialNumber     string          `json:"serialNumber"`
	CpuModel         string          `json:"cpuModel"`
	CpuCores         int             `json:"cpuCores"`
	RamGb            int             `json:"ramGb"`
	NICs             []NIC           `json:"nics"`
	Storage          []StorageDevice `json:"storage"`
	SuggestedName    string          `json:"suggestedName"`
	SuggestedBootMac string          `json:"suggestedBootMac"`
	BootMode         string          `json:"bootMode"`
	DetectedDriver   string          `json:"detectedDriver"`
	BMCAddress       string          `json:"bmcAddress"`
}

type SystemInfo struct {
	Manufacturer   string
	Model          string
	SerialNumber   string
	UUID           string
	BIOSVersion    string
	TotalMemoryGiB int
	ProcessorCount int
	ProcessorModel string
}

type NIC struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	MACAddress    string   `json:"macAddress"`
	SpeedMbps     int      `json:"speedMbps"`
	LinkState     string   `json:"linkState"`
	IPv4Addresses []string `json:"ipv4Addresses"`
}

type StorageDevice struct {
	Name         string `json:"name"`
	SizeGB       int    `json:"sizeGb"`
	MediaType    string `json:"type"`
	Model        string `json:"model"`
	SerialNumber string `json:"serialNumber,omitempty"`
	WWN          string `json:"wwn,omitempty"`
	Protocol     string `json:"protocol,omitempty"`
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleDiscover(w http.ResponseWriter, r *http.Request) {
	var req DiscoverRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("[DISCOVER] ERROR: invalid request body: %v", err)
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	log.Printf("[DISCOVER] Request received for BMC %s (user: %s)", req.BMCAddress, req.Username)

	if req.BMCAddress == "" {
		log.Printf("[DISCOVER] ERROR: bmcAddress is empty")
		writeError(w, http.StatusBadRequest, "bmcAddress is required")
		return
	}
	if req.Username == "" || req.Password == "" {
		log.Printf("[DISCOVER] ERROR: missing credentials for %s", req.BMCAddress)
		writeError(w, http.StatusBadRequest, "username and password are required")
		return
	}

	baseURL := "https://" + req.BMCAddress
	client := NewRedfishClient(baseURL, req.Username, req.Password)

	log.Printf("[DISCOVER] Connecting to Redfish at %s", baseURL)
	resp, systemPath, err := client.Discover()
	if err != nil {
		log.Printf("[DISCOVER] ERROR: discovery failed for %s: %v", req.BMCAddress, err)
		writeError(w, http.StatusBadGateway, "redfish discovery failed: "+err.Error())
		return
	}

	driver := detectDriver(resp.Manufacturer)
	resp.DetectedDriver = driver
	resp.BMCAddress = fmt.Sprintf("%s://%s%s", driver, req.BMCAddress, systemPath)

	log.Printf("[DISCOVER] SUCCESS: %s %s (serial: %s) — %d NICs, %d storage devices, driver: %s, boot MAC: %s",
		resp.Manufacturer, resp.Model, resp.SerialNumber,
		len(resp.NICs), len(resp.Storage), driver, resp.SuggestedBootMac)

	for i, nic := range resp.NICs {
		log.Printf("[DISCOVER]   NIC[%d]: id=%s name=%s mac=%s link=%s speed=%dMbps",
			i, nic.ID, nic.Name, nic.MACAddress, nic.LinkState, nic.SpeedMbps)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

type LogRequest struct {
	Level   string `json:"level"`
	Action  string `json:"action"`
	Message string `json:"message"`
	Details string `json:"details,omitempty"`
}

func handleLog(w http.ResponseWriter, r *http.Request) {
	var req LogRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	level := strings.ToUpper(req.Level)
	if level == "" {
		level = "INFO"
	}

	if req.Details != "" {
		log.Printf("[DASHBOARD] [%s] %s: %s — %s", level, req.Action, req.Message, req.Details)
	} else {
		log.Printf("[DASHBOARD] [%s] %s: %s", level, req.Action, req.Message)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "logged"})
}

func detectDriver(manufacturer string) string {
	m := strings.ToLower(manufacturer)
	if strings.Contains(m, "dell") {
		return "idrac-virtualmedia"
	}
	if strings.Contains(m, "hpe") || strings.Contains(m, "hewlett") {
		return "redfish-virtualmedia"
	}
	return "redfish-virtualmedia"
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}
