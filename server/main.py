import os
import re
import time
import random
import shutil
import subprocess
import socket
import struct
import json
import threading
from datetime import datetime, timezone
from contextlib import asynccontextmanager
import httpx

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

# In-memory store for discovered LocalSend peers and active sessions
localsend_peers = {}  # fingerprint -> dict of peer info
localsend_sessions = {}  # sessionId -> dict of session info
MY_FINGERPRINT = f"antigravity-{random.randint(100000, 999999)}"

# Directories
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
WORKSPACE_DIR = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
UPLOADS_DIR = os.path.join(WORKSPACE_DIR, "uploads")
RECEIVED_DIR = os.path.join(WORKSPACE_DIR, "received")
STATIC_DIR = os.path.join(WORKSPACE_DIR, "dist/taildrop-app/browser")

# Ensure directories exist
os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(RECEIVED_DIR, exist_ok=True)

# UDP Multicast functions for LocalSend Discovery
def broadcast_presence():
    multicast_group = ('224.0.0.167', 53317)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(1.0)
    # Set TTL of multicast messages to 1 (local subnet)
    ttl = struct.pack('b', 1)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, ttl)
    
    payload = {
        "alias": "Taildrop Web Server",
        "version": "2.0",
        "deviceModel": "Python Backend",
        "deviceType": "server",
        "fingerprint": MY_FINGERPRINT,
        "port": 3000,
        "protocol": "http",
        "announcement": True
    }
    
    try:
        sock.sendto(json.dumps(payload).encode('utf-8'), multicast_group)
    except Exception as e:
        print(f"Error broadcasting presence: {e}")
    finally:
        sock.close()

def register_back_sync(ip: str, port: int, protocol: str):
    url = f"{protocol}://{ip}:{port}/api/localsend/v2/register"
    payload = {
        "alias": "MultiDrop Web Server",
        "version": "2.0",
        "deviceModel": "Python Backend",
        "deviceType": "server",
        "fingerprint": MY_FINGERPRINT,
        "port": 3000,
        "protocol": "http",
        "download": True
    }
    try:
        # Use verify=False because LocalSend always uses self-signed certs in HTTPS mode
        with httpx.Client(verify=False, timeout=3.0) as client:
            resp = client.post(url, json=payload)
            if resp.status_code == 200:
                print(f"Successfully registered back with LocalSend device at {ip}:{port}")
                return
    except Exception as e:
        print(f"Failed to register back via LocalSend V2 with {ip}:{port}: {e}")
        
    # Fallback to V1
    url_v1 = f"{protocol}://{ip}:{port}/api/localsend/v1/register"
    try:
        with httpx.Client(verify=False, timeout=3.0) as client:
            resp = client.post(url_v1, json=payload)
            if resp.status_code == 200:
                print(f"Successfully registered back via LocalSend V1 with {ip}:{port}")
    except Exception as e:
        print(f"Failed to register back via LocalSend V1 with {ip}:{port}: {e}")

def start_udp_listener():
    def listen():
        multicast_group = '224.0.0.167'
        server_address = ('', 53317)

        # Create the socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except AttributeError:
            pass

        # Bind to the server address
        try:
            sock.bind(server_address)
        except Exception as e:
            print(f"Could not bind to UDP port 53317 (might be in use by another LocalSend client): {e}")
            return

        # Tell the operating system to add the socket to the multicast group on all interfaces
        group = socket.inet_aton(multicast_group)
        mreq = struct.pack('4sL', group, socket.INADDR_ANY)
        try:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
        except Exception as e:
            print(f"Error joining multicast group: {e}")
            # Non-fatal; we can still receive direct UDP traffic
            pass

        print("LocalSend UDP discovery listener started on port 53317...")
        while True:
            try:
                data, address = sock.recvfrom(65535)
                ip = address[0]
                try:
                    payload = json.loads(data.decode('utf-8'))
                    if "alias" in payload and "fingerprint" in payload:
                        fingerprint = payload.get("fingerprint")
                        
                        # Avoid self-discovery
                        if fingerprint == MY_FINGERPRINT:
                            continue
                            
                        port = payload.get("port", 53317)
                        alias = payload.get("alias")
                        device_type = payload.get("deviceType", "desktop")
                        device_model = payload.get("deviceModel", "Unknown")
                        protocol = payload.get("protocol", "http")
                        
                        localsend_peers[fingerprint] = {
                            "ip": ip,
                            "port": port,
                            "alias": alias,
                            "deviceModel": device_model,
                            "deviceType": device_type,
                            "fingerprint": fingerprint,
                            "protocol": protocol,
                            "last_seen": time.time()
                        }

                        # If they are broadcasting (announcement is true),
                        # we register ourselves back to their HTTP server
                        if payload.get("announcement") is True:
                            threading.Thread(
                                target=register_back_sync,
                                args=(ip, port, protocol),
                                daemon=True
                            ).start()
                except Exception:
                    pass
            except Exception as e:
                print(f"UDP listener error: {e}")
                time.sleep(1)

    t = threading.Thread(target=listen, daemon=True)
    t.start()

async def async_broadcast():
    import asyncio
    await asyncio.to_thread(broadcast_presence)

# LocalSend Upload function
async def upload_localsend(peer, file_path, original_filename, file_size, mime_type):
    # Set default mime_type if empty
    if not mime_type:
        mime_type = "application/octet-stream"
        
    url_prepare = f"{peer['protocol']}://{peer['ip']}:{peer['port']}/api/localsend/v2/prepare-upload"
    info_payload = {
        "info": {
            "alias": "Taildrop Web Server",
            "version": "2.0",
            "deviceModel": "Python Backend",
            "deviceType": "server",
            "fingerprint": MY_FINGERPRINT,
            "port": 3000,
            "protocol": "http"
        },
        "files": {
            "file-1": {
                "id": "file-1",
                "fileName": original_filename,
                "size": file_size,
                "fileType": mime_type
            }
        }
    }
    
    # Verify is False because LocalSend uses self-signed certs
    async with httpx.AsyncClient(verify=False, timeout=60.0) as client:
        try:
            resp = await client.post(url_prepare, json=info_payload)
        except Exception as e:
            raise Exception(f"Failed to connect to LocalSend peer: {e}")
            
        if resp.status_code == 403:
            raise Exception("Transfer rejected by the receiving device")
        elif resp.status_code != 200:
            raise Exception(f"Prepare upload failed with status {resp.status_code}: {resp.text}")
            
        data = resp.json()
        session_id = data.get("sessionId")
        files_map = data.get("files", {})
        token = files_map.get("file-1")
        
        if not session_id or not token:
            raise Exception("Invalid response from LocalSend device during handshake")
            
        url_upload = f"{peer['protocol']}://{peer['ip']}:{peer['port']}/api/localsend/v2/upload"
        params = {
            "sessionId": session_id,
            "fileId": "file-1",
            "token": token
        }
        
        async def file_generator():
            import asyncio
            def read_chunk(file_handle):
                return file_handle.read(65536)
            with open(file_path, "rb") as f:
                while True:
                    chunk = await asyncio.to_thread(read_chunk, f)
                    if not chunk:
                        break
                    yield chunk

        # Upload binary file content
        upload_resp = await client.post(url_upload, params=params, content=file_generator())
            
        if upload_resp.status_code not in (200, 204):
            raise Exception(f"Upload failed with status {upload_resp.status_code}: {upload_resp.text}")

# Lifespan context manager for FastAPI startup/shutdown events
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: start UDP listener and send initial broadcast
    start_udp_listener()
    broadcast_presence()
    yield
    # Shutdown: clean up if needed
    pass

app = FastAPI(title="Taildrop Transfer API", lifespan=lifespan)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Helper to query the local tailscaled socket
async def query_local_api(api_path: str):
    uds_path = "/var/run/tailscale/tailscaled.sock"
    if not os.path.exists(uds_path):
        raise HTTPException(
            status_code=500,
            detail=f"Tailscaled Unix socket not found at {uds_path}"
        )
    
    transport = httpx.AsyncHTTPTransport(uds=uds_path)
    async with httpx.AsyncClient(transport=transport) as client:
        response = await client.get(
            f"http://local-tailscaled.sock{api_path}",
            headers={"Host": "local-tailscaled.sock"}
        )
        if response.status_code < 200 or response.status_code >= 300:
            raise HTTPException(
                status_code=500,
                detail=f"LocalAPI returned status {response.status_code}: {response.text}"
            )
        return response.json()

# Endpoint: Get status (current node and peers)
@app.get("/api/status")
async def get_status():
    # Asynchronously broadcast UDP presence to discover new LocalSend devices
    import asyncio
    asyncio.create_task(async_broadcast())

    try:
        # 1. Fetch Tailscale status & file targets
        try:
            status_data = await query_local_api("/localapi/v0/status")
            targets_data = await query_local_api("/localapi/v0/file-targets") or []
            
            self_info = status_data.get("Self", {})
            ips = self_info.get("TailscaleIPs", [])
            self_node = {
                "hostName": self_info.get("HostName"),
                "dnsName": self_info.get("DNSName"),
                "os": self_info.get("OS"),
                "ip": ips[0] if ips else None,
                "online": True
            }
            
            peers = []
            peer_status_map = status_data.get("Peer", {}) or {}
            for target in targets_data:
                node = target.get("Node", {})
                node_key = node.get("Key")
                status_peer = peer_status_map.get(node_key) if node_key else None
                addresses = node.get("Addresses", [])
                ip = addresses[0].split("/")[0] if addresses else None
                peers.append({
                    "id": node.get("ID"),
                    "hostName": node.get("ComputedName"),
                    "dnsName": node.get("Name"),
                    "os": node.get("Hostinfo", {}).get("OS", "unknown") if node.get("Hostinfo") else "unknown",
                    "ip": ip,
                    "online": node.get("Online", False),
                    "expired": node.get("Expired", False),
                    "active": status_peer.get("Active", False) if status_peer else False,
                    "curAddr": status_peer.get("CurAddr") if status_peer else None,
                    "relay": status_peer.get("Relay") if status_peer else None
                })
        except Exception as ts_err:
            print(f"Tailscale status fetch skipped/failed (non-fatal): {ts_err}")
            self_node = {
                "hostName": socket.gethostname(),
                "dnsName": "local-device",
                "os": "linux",
                "ip": "127.0.0.1",
                "online": True
            }
            peers = []

        # 2. Add discovered LocalSend peers
        now = time.time()
        # Remove LocalSend peers not seen in the last 60 seconds
        stale_keys = [k for k, p in localsend_peers.items() if now - p["last_seen"] > 60]
        for k in stale_keys:
            localsend_peers.pop(k, None)
            
        for fingerprint, peer in localsend_peers.items():
            peers.append({
                "id": f"localsend-{fingerprint}",
                "hostName": f"{peer['alias']} (LocalSend)",
                "dnsName": f"localsend-{fingerprint}",
                "os": peer["deviceType"],  # frontend getOsColor maps standard keys
                "ip": peer["ip"],
                "online": True,
                "expired": False,
                "active": True,
                "curAddr": f"Port {peer['port']}",
                "relay": "LocalSend Protocol"
            })

        return {"self": self_node, "peers": peers}
    except Exception as e:
        print(f"Error fetching status: {e}")
        return JSONResponse(
            status_code=500,
            content={
                "error": "Failed to fetch device status",
                "details": str(e)
            }
        )

# Endpoint: Ping a peer to get latency
@app.get("/api/ping/{peer}")
async def ping_peer(peer: str):
    # Check if this is a LocalSend peer
    ls_peer = None
    for p in localsend_peers.values():
        if f"localsend-{p['fingerprint']}" == peer or p['alias'] == peer or f"{p['alias']} (LocalSend)" == peer:
            ls_peer = p
            break

    if ls_peer:
        # Measure latency to the LocalSend HTTP info endpoint
        start_time = time.time()
        url = f"{ls_peer['protocol']}://{ls_peer['ip']}:{ls_peer['port']}/api/localsend/v2/info"
        try:
            async with httpx.AsyncClient(verify=False, timeout=3.0) as client:
                resp = await client.get(url)
                if resp.status_code == 200:
                    latency_ms = int((time.time() - start_time) * 1000)
                    return {
                        "success": True,
                        "latencyMs": latency_ms,
                        "direct": True,
                        "output": f"LocalSend response from {ls_peer['alias']} ({ls_peer['ip']})"
                    }
        except Exception as e:
            print(f"LocalSend info check failed for ping: {e}")
            
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": "Ping failed",
                "details": f"Could not connect to LocalSend peer at {ls_peer['ip']}:{ls_peer['port']}"
            }
        )

    # Standard Tailscale ping
    if not re.match(r"^[a-zA-Z0-9\-_.]+$", peer):
        raise HTTPException(status_code=400, detail="Invalid peer hostname")

    try:
        import asyncio
        result = await asyncio.to_thread(
            subprocess.run,
            ["tailscale", "ping", "--c=1", peer],
            capture_output=True,
            text=True,
            timeout=10.0
        )
        output = (result.stdout or "") + (result.stderr or "")
        match = re.search(r"in (\d+)ms", output)
        latency_ms = int(match.group(1)) if match else None

        if latency_ms is not None:
            is_direct = "DERP" not in output and "relay" not in output and "via" in output
            return {
                "success": True,
                "latencyMs": latency_ms,
                "direct": is_direct,
                "output": output.strip()
            }

        print(f"Tailscale ping failed for {peer}: {output}")
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": "Ping failed or timed out",
                "details": output.strip()
            }
        )
    except Exception as e:
        print(f"Tailscale ping exception: {e}")
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": "Ping failed to execute",
                "details": str(e)
            }
        )

# Endpoint: Send file to a peer
@app.post("/api/send")
async def send_file(target: str = Form(...), file: UploadFile = File(...)):
    if not file:
        raise HTTPException(status_code=400, detail="No file uploaded")
    if not target:
        raise HTTPException(status_code=400, detail="No target peer specified")

    # Save the file to UPLOADS_DIR with a unique name first
    unique_suffix = f"{int(time.time() * 1000)}-{random.randint(0, int(1e9))}"
    uploaded_filename = f"{unique_suffix}-{file.filename}"
    upload_file_path = os.path.join(UPLOADS_DIR, uploaded_filename)

    try:
        with open(upload_file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save uploaded file: {str(e)}")

    file_size = os.path.getsize(upload_file_path)

    # Check if target is a LocalSend peer
    ls_peer = None
    for p in localsend_peers.values():
        target_name = f"{p['alias']} (LocalSend)"
        if target == target_name or target == p['alias'] or target == f"localsend-{p['fingerprint']}":
            ls_peer = p
            break

    if ls_peer:
        try:
            await upload_localsend(ls_peer, upload_file_path, file.filename, file_size, file.content_type)
            if os.path.exists(upload_file_path):
                os.remove(upload_file_path)
            return {"success": True, "message": f"Successfully sent {file.filename} to {ls_peer['alias']} via LocalSend"}
        except Exception as e:
            if os.path.exists(upload_file_path):
                os.remove(upload_file_path)
            print(f"LocalSend send file failed: {e}")
            return JSONResponse(
                status_code=500,
                content={
                    "error": "Failed to send file via LocalSend",
                    "details": str(e)
                }
            )

    # Standard Tailscale send workflow
    temp_dir = os.path.join(UPLOADS_DIR, f"temp-{int(time.time() * 1000)}")
    os.makedirs(temp_dir, exist_ok=True)
    temp_file_path = os.path.join(temp_dir, file.filename)

    try:
        shutil.copyfile(upload_file_path, temp_file_path)
    except Exception as e:
        if os.path.exists(upload_file_path):
            os.remove(upload_file_path)
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Failed to prepare file for transfer: {str(e)}")

    target_with_colon = f"{target}:"
    print(f"Sending file via tailscale file cp {temp_file_path} {target_with_colon}")

    try:
        import asyncio
        result = await asyncio.to_thread(
            subprocess.run,
            ["tailscale", "file", "cp", temp_file_path, target_with_colon],
            capture_output=True,
            text=True,
            timeout=600.0
        )

        if os.path.exists(upload_file_path):
            os.remove(upload_file_path)
        shutil.rmtree(temp_dir, ignore_errors=True)

        if result.returncode != 0:
            stderr = result.stderr or ""
            print(f"Tailscale file cp error: {result.returncode}, {stderr}")
            return JSONResponse(
                status_code=500,
                content={
                    "error": "Failed to send file via Taildrop",
                    "details": stderr or f"Process exited with code {result.returncode}"
                }
            )

        return {"success": True, "message": f"Successfully sent {file.filename} to {target}"}
    except Exception as e:
        if os.path.exists(upload_file_path):
            os.remove(upload_file_path)
        shutil.rmtree(temp_dir, ignore_errors=True)
        print(f"Tailscale file cp exception: {e}")
        return JSONResponse(
            status_code=500,
            content={
                "error": "Failed to send file via Taildrop",
                "details": str(e)
            }
        )

# Endpoint: Get received files (runs tailscale file get and reads received folder)
@app.get("/api/inbox")
async def get_inbox():
    try:
        import asyncio
        await asyncio.to_thread(
            subprocess.run,
            ["tailscale", "file", "get", "--wait=false", RECEIVED_DIR],
            capture_output=True,
            text=True,
            timeout=10.0
        )
    except Exception as e:
        print(f"Tailscale file get error (non-fatal): {e}")

    try:
        file_details = []
        if os.path.exists(RECEIVED_DIR):
            for filename in os.listdir(RECEIVED_DIR):
                file_path = os.path.join(RECEIVED_DIR, filename)
                try:
                    stats = os.stat(file_path)
                    dt = datetime.fromtimestamp(stats.st_mtime, tz=timezone.utc)
                    iso_time = dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
                    file_details.append({
                        "filename": filename,
                        "size": stats.st_size,
                        "receivedAt": iso_time
                    })
                except Exception:
                    dt = datetime.now(timezone.utc)
                    iso_time = dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
                    file_details.append({
                        "filename": filename,
                        "size": 0,
                        "receivedAt": iso_time
                    })

        file_details.sort(key=lambda x: x["receivedAt"], reverse=True)
        return file_details
    except Exception as e:
        print(f"Failed to read received directory: {e}")
        raise HTTPException(status_code=500, detail="Failed to read received files")

# Endpoint: Download a received file
@app.get("/api/download/{filename}")
async def download_file(filename: str):
    safe_filename = os.path.basename(filename)
    file_path = os.path.join(RECEIVED_DIR, safe_filename)

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(
        path=file_path,
        filename=safe_filename,
        media_type="application/octet-stream"
    )

# Endpoint: Delete a received file
@app.delete("/api/inbox/{filename}")
async def delete_file(filename: str):
    safe_filename = os.path.basename(filename)
    file_path = os.path.join(RECEIVED_DIR, safe_filename)

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")

    try:
        if os.path.isdir(file_path):
            shutil.rmtree(file_path)
        else:
            os.remove(file_path)
        return {"success": True, "message": f"Successfully deleted {filename}"}
    except Exception as e:
        print(f"Error deleting file {filename}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete file: {str(e)}")

# Endpoint: Extract a received zip file
@app.post("/api/extract/{filename}")
async def extract_zip(filename: str):
    safe_filename = os.path.basename(filename)
    file_path = os.path.join(RECEIVED_DIR, safe_filename)

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")

    if not safe_filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="Only .zip files can be extracted")

    folder_name = safe_filename[:-4]
    extract_dest_dir = os.path.join(RECEIVED_DIR, folder_name)
    os.makedirs(extract_dest_dir, exist_ok=True)

    try:
        import asyncio
        result = await asyncio.to_thread(
            subprocess.run,
            ["unzip", "-o", file_path, "-d", extract_dest_dir],
            capture_output=True,
            text=True,
            timeout=60.0
        )
        if result.returncode != 0:
            stderr = result.stderr or ""
            print(f"Failed to extract zip file: {result.returncode}, {stderr}")
            return JSONResponse(
                status_code=500,
                content={
                    "error": 'Extraction failed. Make sure "unzip" is installed on the server.',
                    "details": stderr or f"Process exited with code {result.returncode}"
                }
            )

        return {
            "success": True,
            "message": f"Successfully extracted archive to folder \"{folder_name}\"",
            "extractedFolder": folder_name
        }
    except Exception as e:
        print(f"Extraction exception: {e}")
        return JSONResponse(
            status_code=500,
            content={
                "error": 'Extraction failed. Make sure "unzip" is installed on the server.',
                "details": str(e)
            }
        )

# LocalSend Protocol Endpoints (for receiving files from other LocalSend clients)
@app.get("/api/localsend/v2/info")
@app.get("/api/localsend/v1/info")
async def localsend_info():
    return {
        "alias": "MultiDrop Web Server",
        "version": "2.0",
        "deviceModel": "Python Backend",
        "deviceType": "server",
        "fingerprint": MY_FINGERPRINT,
        "port": 3000,
        "protocol": "http",
        "download": True
    }

@app.post("/api/localsend/v2/register")
@app.post("/api/localsend/v1/register")
async def localsend_register(request_body: dict, request: Request):
    client_ip = request.client.host
    alias = request_body.get("alias")
    fingerprint = request_body.get("fingerprint")
    if alias and fingerprint:
        localsend_peers[fingerprint] = {
            "ip": client_ip,
            "port": request_body.get("port", 53317),
            "alias": alias,
            "deviceModel": request_body.get("deviceModel", "Unknown"),
            "deviceType": request_body.get("deviceType", "desktop"),
            "fingerprint": fingerprint,
            "protocol": request_body.get("protocol", "http"),
            "last_seen": time.time()
        }
    
    return {
        "alias": "MultiDrop Web Server",
        "version": "2.0",
        "deviceModel": "Python Backend",
        "deviceType": "server",
        "fingerprint": MY_FINGERPRINT,
        "port": 3000,
        "protocol": "http",
        "download": True
    }

@app.post("/api/localsend/v2/prepare-upload")
async def localsend_prepare_upload(request: dict):
    files = request.get("files", {})
    session_id = f"session-{random.randint(100000, 999999)}"
    
    session_files = {}
    response_files = {}
    for fid, file_info in files.items():
        token = f"token-{random.randint(100000, 999999)}"
        session_files[fid] = {
            "filename": file_info.get("fileName"),
            "size": file_info.get("size"),
            "token": token
        }
        response_files[fid] = token
        
    localsend_sessions[session_id] = {
        "files": session_files,
        "created_at": time.time()
    }
    
    return {
        "sessionId": session_id,
        "files": response_files
    }

@app.post("/api/localsend/v2/upload")
async def localsend_upload(
    sessionId: str,
    fileId: str,
    token: str,
    file: UploadFile = File(...)
):
    session = localsend_sessions.get(sessionId)
    if not session:
        raise HTTPException(status_code=409, detail="Session not found or expired")
        
    file_info = session["files"].get(fileId)
    if not file_info or file_info["token"] != token:
        raise HTTPException(status_code=401, detail="Invalid file token")
        
    safe_filename = os.path.basename(file_info["filename"])
    dest_path = os.path.join(RECEIVED_DIR, safe_filename)
    
    try:
        with open(dest_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    except Exception as e:
        print(f"Error saving LocalSend file: {e}")
        raise HTTPException(status_code=500, detail="Failed to save file")
        
    return {"success": True}

# Wildcard route to serve Angular SPA index.html for non-API routes
@app.get("/{catchall:path}")
async def serve_spa(catchall: str):
    if catchall.startswith("api"):
        raise HTTPException(status_code=404, detail="API endpoint not found")
        
    file_path = os.path.join(STATIC_DIR, catchall)
    if os.path.exists(file_path) and os.path.isfile(file_path):
        return FileResponse(file_path)

    index_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)

    return JSONResponse(status_code=404, content={"detail": "Not Found"})

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 3000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
