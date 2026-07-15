# Design Spec: Docker Hub README Customization
**Date**: 2026-07-15
**Status**: Proposal

## 1. Overview
The goal is to create a customized version of the project's README specifically tailored for Docker Hub visitors. Unlike the repository's development-oriented `README.md`, the Docker Hub version (`README-dockerhub.md`) will focus on running the pre-built image, understanding requirements, and configuration mappings.

## 2. Key Customizations for Docker Hub
- **No Build Instructions**: Remove local setup, `venv`, `npm install`, `npm run dev`, and testing guides.
- **Pre-requisite Focus**: Highlight the requirements for running Tailscale on the host and sharing the tailscaled socket.
- **No Mermaid Diagrams**: Replace the Mermaid flow diagram with a simple, high-level textual explanation of the architecture, as Docker Hub does not native-render Mermaid syntax.
- **Docker-First Instructions**: Lead immediately with the Docker Compose setup and docker run command.

## 3. README-dockerhub.md Content Structure
- **Title & Description**: Brief, high-level overview of MultiDrop (Taildrop & LocalSend).
- **Prerequisites**: Detail host requirements (Tailscaled service running, correct socket path).
- **Run with Docker Compose (Recommended)**:
  - Compose configuration snippet.
  - Detail explanation of `network_mode: host` and critical volume mounts.
- **Run with Docker CLI**:
  - `docker run` command version.
- **Configuration & Persistence**:
  - Explanations of port bindings (3000 for interface, 53317 for LocalSend multicast).
  - Volume mappings for `/app/received` (local inbox downloads).
