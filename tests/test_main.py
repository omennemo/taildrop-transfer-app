import sys
import os
import time
import pytest
from unittest.mock import patch, MagicMock, AsyncMock
from fastapi.testclient import TestClient

# Add project root to python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from server.main import app, localsend_peers, localsend_sessions, MY_FINGERPRINT

client = TestClient(app)

# Dummy test data for Tailscale local API status and targets
MOCK_STATUS_DATA = {
    "Self": {
        "HostName": "my-local-host",
        "DNSName": "my-local-host.tailnet.net",
        "OS": "linux",
        "TailscaleIPs": ["100.64.0.1"]
    },
    "Peer": {
        "nodekey1": {
            "Active": True,
            "CurAddr": "192.168.1.100:41641",
            "Relay": ""
        }
    }
}

MOCK_TARGETS_DATA = [
    {
        "Node": {
            "ID": "node-1",
            "ComputedName": "peer-host-1",
            "Name": "peer-host-1.tailnet.net",
            "Key": "nodekey1",
            "Addresses": ["100.64.0.2/32"],
            "Online": True,
            "Expired": False,
            "Hostinfo": {
                "OS": "android"
            }
        }
    }
]

# 1. Test standard root / SPA wildcard route fallback
def test_spa_wildcard_fallback():
    response = client.get("/some-custom-spa-route")
    # If the static dist folder is not compiled yet in local tests, it should return 404.
    # If dist exists, it should return 200 (serving index.html). Both are expected behavior.
    assert response.status_code in (200, 404)

# 2. Test status endpoint (tailscale + localsend merge)
@patch('server.main.query_local_api')
def test_get_status_success(mock_query):
    # Setup mock for tailscale local API calls
    async def side_effect(path):
        if path == "/localapi/v0/status":
            return MOCK_STATUS_DATA
        elif path == "/localapi/v0/file-targets":
            return MOCK_TARGETS_DATA
        return None
    mock_query.side_effect = side_effect

    # Setup mock localsend peer
    localsend_peers.clear()
    localsend_peers["ls-fingerprint"] = {
        "ip": "192.168.1.50",
        "port": 53317,
        "alias": "My Phone",
        "deviceModel": "Pixel",
        "deviceType": "mobile",
        "fingerprint": "ls-fingerprint",
        "protocol": "http",
        "last_seen": time.time()
    }

    response = client.get("/api/status")
    assert response.status_code == 200
    data = response.json()

    # Assert Self Info
    assert data["self"]["hostName"] == "my-local-host"
    assert data["self"]["ip"] == "100.64.0.1"

    # Assert merged peers list contains Tailscale peer
    ts_peers = [p for p in data["peers"] if not p["id"].startswith("localsend-")]
    assert len(ts_peers) == 1
    assert ts_peers[0]["hostName"] == "peer-host-1"
    assert ts_peers[0]["ip"] == "100.64.0.2"

    # Assert merged peers list contains LocalSend peer
    ls_peers = [p for p in data["peers"] if p["id"].startswith("localsend-")]
    assert len(ls_peers) == 1
    assert ls_peers[0]["hostName"] == "My Phone (LocalSend)"
    assert ls_peers[0]["ip"] == "192.168.1.50"

# 3. Test ping endpoint (Tailscale)
@patch('asyncio.to_thread')
def test_ping_tailscale(mock_to_thread):
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "pinging peer-host-1... via DERP... in 45ms"
    mock_result.stderr = ""
    mock_to_thread.return_value = mock_result

    response = client.get("/api/ping/peer-host-1")
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["latencyMs"] == 45
    assert data["direct"] is False

# 4. Test ping endpoint (LocalSend)
@patch('httpx.AsyncClient.get')
def test_ping_localsend(mock_httpx_get):
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "alias": "My Phone",
        "version": "2.0"
    }
    mock_httpx_get.return_value = mock_response

    localsend_peers["ls-fingerprint"] = {
        "ip": "192.168.1.50",
        "port": 53317,
        "alias": "My Phone",
        "deviceModel": "Pixel",
        "deviceType": "mobile",
        "fingerprint": "ls-fingerprint",
        "protocol": "http",
        "last_seen": time.time()
    }

    response = client.get("/api/ping/localsend-ls-fingerprint")
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert "latencyMs" in data

# 5. Test send endpoint (Tailscale path)
@patch('shutil.copyfile')
@patch('os.remove')
@patch('shutil.rmtree')
@patch('asyncio.to_thread')
def test_send_file_tailscale(mock_to_thread, mock_rmtree, mock_remove, mock_copyfile):
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "Successfully sent"
    mock_result.stderr = ""
    mock_to_thread.return_value = mock_result

    file_content = b"hello unit tests"
    files = {"file": ("test.txt", file_content, "text/plain")}
    data = {"target": "peer-host-1"}

    response = client.post("/api/send", data=data, files=files)
    assert response.status_code == 200
    assert response.json()["success"] is True

# 6. Test send endpoint (LocalSend path)
@patch('server.main.upload_localsend', new_callable=AsyncMock)
@patch('os.remove')
def test_send_file_localsend(mock_remove, mock_upload_localsend):
    localsend_peers["ls-fingerprint"] = {
        "ip": "192.168.1.50",
        "port": 53317,
        "alias": "My Phone",
        "deviceModel": "Pixel",
        "deviceType": "mobile",
        "fingerprint": "ls-fingerprint",
        "protocol": "http",
        "last_seen": time.time()
    }

    file_content = b"hello localsend test"
    files = {"file": ("image.png", file_content, "image/png")}
    data = {"target": "My Phone (LocalSend)"}

    response = client.post("/api/send", data=data, files=files)
    assert response.status_code == 200
    assert response.json()["success"] is True
    mock_upload_localsend.assert_called_once()

# 7. LocalSend Info API
def test_localsend_info_endpoint():
    response = client.get("/api/localsend/v2/info")
    assert response.status_code == 200
    data = response.json()
    assert data["alias"] == "Taildrop Web Server"
    assert data["fingerprint"] == MY_FINGERPRINT

# 8. LocalSend Register API
def test_localsend_register_endpoint():
    payload = {
        "alias": "Test iPhone",
        "fingerprint": "iphone-fingerprint-777",
        "port": 53317,
        "deviceModel": "iPhone 15",
        "deviceType": "mobile",
        "protocol": "http"
    }
    response = client.post("/api/localsend/v2/register", json=payload)
    assert response.status_code == 200
    assert response.json()["fingerprint"] == MY_FINGERPRINT
    # Verify peer is added to memory store
    assert "iphone-fingerprint-777" in localsend_peers
    assert localsend_peers["iphone-fingerprint-777"]["alias"] == "Test iPhone"

# 9. LocalSend Prepare Upload Handshake API
def test_localsend_prepare_upload_endpoint():
    payload = {
        "info": {
            "alias": "Test iPhone",
            "fingerprint": "iphone-fingerprint-777"
        },
        "files": {
            "fileId-99": {
                "fileName": "avatar.png",
                "size": 500
            }
        }
    }
    response = client.post("/api/localsend/v2/prepare-upload", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "sessionId" in data
    assert "fileId-99" in data["files"]
    
    session_id = data["sessionId"]
    assert session_id in localsend_sessions
    assert localsend_sessions[session_id]["files"]["fileId-99"]["filename"] == "avatar.png"

# 10. LocalSend File Upload Binary API
@patch('shutil.copyfileobj')
def test_localsend_upload_endpoint(mock_copyfileobj):
    # Setup mock active upload session
    session_id = "mock-session-abc"
    token = "mock-token-xyz"
    localsend_sessions[session_id] = {
        "files": {
            "fid-1": {
                "filename": "hello.txt",
                "size": 25,
                "token": token
            }
        }
    }

    file_content = b"some sample content text"
    files = {"file": ("hello.txt", file_content, "text/plain")}

    response = client.post(
        f"/api/localsend/v2/upload?sessionId={session_id}&fileId=fid-1&token={token}",
        files=files
    )
    assert response.status_code == 200
    assert response.json()["success"] is True

# 11. Inbox actions: Download non-existent file
def test_download_file_not_found():
    response = client.get("/api/download/nonexistent-file.pdf")
    assert response.status_code == 404

# 12. Inbox actions: Delete non-existent file
def test_delete_file_not_found():
    response = client.delete("/api/inbox/nonexistent-file.pdf")
    assert response.status_code == 404
