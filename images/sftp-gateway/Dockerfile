FROM golang:1.23-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o sftp-gateway .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=builder /build/sftp-gateway /usr/local/bin/sftp-gateway
EXPOSE 2222 2121 8080
ENTRYPOINT ["sftp-gateway"]
