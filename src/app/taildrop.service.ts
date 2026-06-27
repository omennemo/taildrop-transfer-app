import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface Self {
  hostName: string;
  dnsName: string;
  os: string;
  ip: string | null;
  online: boolean;
}

export interface Peer {
  id: string;
  hostName: string;
  dnsName: string;
  os: string;
  ip: string | null;
  online: boolean;
  expired: boolean;
  active?: boolean;
  curAddr?: string | null;
  relay?: string | null;
  latency?: number | null;
  pinging?: boolean;
}

export interface InboxFile {
  filename: string;
  size: number;
  receivedAt: string;
}

@Injectable({
  providedIn: 'root'
})
export class TaildropService {
  private readonly http = inject(HttpClient);

  getStatus(): Observable<{ self: Self; peers: Peer[] }> {
    return this.http.get<{ self: Self; peers: Peer[] }>('/api/status');
  }

  getInbox(): Observable<InboxFile[]> {
    return this.http.get<InboxFile[]>('/api/inbox');
  }

  sendFile(targetHostName: string, file: File): Observable<{ success: boolean; message: string }> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('target', targetHostName);
    return this.http.post<{ success: boolean; message: string }>('/api/send', formData);
  }

  deleteFile(filename: string): Observable<{ success: boolean; message: string }> {
    return this.http.delete<{ success: boolean; message: string }>(`/api/inbox/${encodeURIComponent(filename)}`);
  }

  pingPeer(peerHostName: string): Observable<{ success: boolean; latencyMs: number; direct: boolean; output: string }> {
    return this.http.get<{ success: boolean; latencyMs: number; direct: boolean; output: string }>(`/api/ping/${encodeURIComponent(peerHostName)}`);
  }

  extractZip(filename: string): Observable<{ success: boolean; message: string; extractedFolder: string }> {
    return this.http.post<{ success: boolean; message: string; extractedFolder: string }>(`/api/extract/${encodeURIComponent(filename)}`, {});
  }
}
