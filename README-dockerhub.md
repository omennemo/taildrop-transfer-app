# MultiDrop Transfer Web Application

MultiDrop is a beautiful, dark-themed, glassmorphic web application built with Angular and a Python FastAPI backend to manage file transfers to other devices on your Tailscale network (Taildrop) and local Wi-Fi network (LocalSend).

This Docker image contains both the Angular frontend and FastAPI backend pre-packaged and ready to run.

## Prerequisites

To use this application fully, the host machine must run Tailscale. The container requires access to the Tailscale daemon socket to interact with your Tailnet peers.

- **Tailscaled socket path**: `/var/run/tailscale/tailscaled.sock` (typically default on Linux/macOS)

## Running with Docker Compose (Recommended)

Since the LocalSend protocol relies on UDP Multicast for network discovery, the Docker container must run in host networking mode.

Create a `docker-compose.yml` file:

```yaml
services:
  taildrop-app:
    image: nimeshvellera/taildrop-transfer-app:latest
    container_name: taildrop-app
    network_mode: "host"
    volumes:
      - /var/run/tailscale/tailscaled.sock:/var/run/tailscale/tailscaled.sock
      - ~/Downloads/Taildrop:/app/received
    restart: unless-stopped
```

### Volume & Port Configurations in Host Mode
* **`network_mode: host`**: Gives the container direct access to all host network interfaces. The app binds to host ports `3000` (interface/API) and `53317` (LocalSend discovery).
* **`/var/run/tailscale/tailscaled.sock:/var/run/tailscale/tailscaled.sock`**: Mounts the host's Tailscale daemon socket. The `tailscale` CLI inside the container will use this connection, allowing it to perform P2P transfers using your host's Tailscale identity.
* **`~/Downloads/Taildrop:/app/received`**: Maps files received via transfers directly into your host's `~/Downloads/Taildrop` directory, making them immediately accessible.

Run the container:
```bash
docker compose up -d
```

Once the container is running, open [http://localhost:3000](http://localhost:3000) in your browser.

## Running with Docker CLI

Alternatively, you can run the container using `docker run`:

```bash
docker run -d \
  --name taildrop-app \
  --network host \
  -v /var/run/tailscale/tailscaled.sock:/var/run/tailscale/tailscaled.sock \
  -v ~/Downloads/Taildrop:/app/received \
  --restart unless-stopped \
  nimeshvellera/taildrop-transfer-app:latest
```
