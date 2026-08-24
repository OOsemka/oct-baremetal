FROM golang:1.22 AS builder
WORKDIR /app
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o discovery-service .

FROM registry.access.redhat.com/ubi9-minimal:latest
WORKDIR /
COPY --from=builder /app/discovery-service /discovery-service
USER 65534:65534
ENTRYPOINT ["/discovery-service"]
