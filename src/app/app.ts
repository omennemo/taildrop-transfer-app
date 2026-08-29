import { Component, signal, computed, inject, OnInit, OnDestroy, effect, untracked } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { TaildropService, Self, Peer, InboxFile, TransferLog } from './taildrop.service';
import JSZip from 'jszip';

export interface QueueItem {
  id: string;
  file: File;
  status: 'pending' | 'sending' | 'success' | 'error';
  message: string;
}

interface PeerLatencyState {
  latency: number | null;
  pinging: boolean;
  curAddr?: string | null;
  relay?: string | null;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  standalone: true,
  imports: []
})
export class App implements OnInit, OnDestroy {
  private readonly taildropService = inject(TaildropService);
  private readonly http = inject(HttpClient);

  // Signal-based resources using rxResource.
  // NOTE: no `params` here on purpose — these are polled via `.reload()` (see ngOnInit),
  // which keeps the previous value visible while refetching. If a changing signal is ever
  // passed as `params` instead, Angular treats each change as a brand new request and resets
  // `.value()` to undefined while it loads, which flashes the whole UI back to its
  // loading/empty state on every poll tick.
  protected readonly statusResource = rxResource<{ self: Self; peers: Peer[] }, unknown>({
    stream: () => this.http.get<{ self: Self; peers: Peer[] }>('/api/status'),
  });

  protected readonly inboxResource = rxResource<InboxFile[], unknown>({
    stream: () => this.http.get<InboxFile[]>('/api/inbox'),
  });

  protected readonly historyResource = rxResource<TransferLog[], unknown>({
    stream: () => this.http.get<TransferLog[]>('/api/history'),
  });

  // Derived state from resources
  protected readonly selfDevice = computed(() => this.statusResource.value()?.self ?? null);
  protected readonly rawPeers = computed(() => this.statusResource.value()?.peers ?? []);

  // Peer latency states (updated by pingDevice)
  private readonly peerLatencies = signal<Map<string, PeerLatencyState>>(new Map());

  // Merged peers: raw peers + latency states
  protected readonly mergedPeers = computed(() => {
    const peers = this.rawPeers();
    const latencies = this.peerLatencies();
    return peers.map((peer: Peer) => {
      const latencyState = latencies.get(peer.id);
      return {
        ...peer,
        latency: latencyState?.latency ?? null,
        pinging: latencyState?.pinging ?? false,
        curAddr: latencyState?.latency ? (latencyState.curAddr ?? peer.curAddr) : peer.curAddr,
        relay: latencyState?.latency ? (latencyState.relay ?? peer.relay) : peer.relay,
      };
    });
  });

  // Inbox files from resource
  protected readonly inboxFiles = computed(() => this.inboxResource.value() ?? []);

  // Transfer history from resource
  protected readonly transferHistory = computed(() => this.historyResource.value() ?? []);

  // UI states
  protected readonly searchQuery = signal<string>('');
  protected readonly selectedPeerId = signal<string | null>(null);
  protected readonly selectedPeer = computed(() => {
    const id = this.selectedPeerId();
    if (!id) return null;
    return this.mergedPeers().find((p: Peer) => p.id === id) ?? null;
  });
  protected readonly selectedFiles = signal<QueueItem[]>([]);
  protected readonly isTransferring = signal<boolean>(false);
  protected readonly isDragging = signal<boolean>(false);
  protected readonly notificationsEnabled = signal<boolean>(false);
  protected readonly isHistoryCollapsed = signal<boolean>(false);

  // Loading & Scanning states
  protected readonly isScanning = signal<boolean>(false);
  protected readonly loadingInbox = signal<boolean>(true);

  protected readonly onlineCount = computed(() => this.mergedPeers().filter((p: Peer) => p.online).length);

  private refreshIntervalId: any = null;
  private knownFileNames = new Set<string>();
  private isInitialInboxLoad = true;

  // Computed signal to filter peers based on search query
  protected readonly filteredPeers = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    const allPeers = this.mergedPeers();

    if (!query) {
      return [...allPeers].sort((a: Peer, b: Peer) => {
        if (a.online === b.online) {
          return a.hostName.localeCompare(b.hostName);
        }
        return a.online ? -1 : 1;
      });
    }

    return allPeers
      .filter((peer: Peer) =>
        peer.hostName.toLowerCase().includes(query) ||
        (peer.ip && peer.ip.includes(query)) ||
        peer.os.toLowerCase().includes(query)
      )
      .sort((a: Peer, b: Peer) => {
        if (a.online === b.online) {
          return a.hostName.localeCompare(b.hostName);
        }
        return a.online ? -1 : 1;
      });
  });

  protected scanNetwork() {
    this.isScanning.set(true);
    this.taildropService.scanNetwork().subscribe({
      next: () => {
        this.statusResource.reload();
        this.isScanning.set(false);
      },
      error: (err) => {
        console.error('Network scan failed:', err);
        this.statusResource.reload();
        this.isScanning.set(false);
      }
    });
  }

  ngOnInit() {
    // Start background polling every 5 seconds. Reload the existing resources in place
    // (rather than changing a `params` signal) so the previously loaded data stays on
    // screen while the refetch is in flight, instead of the UI flashing to empty/loading.
    this.refreshIntervalId = setInterval(() => {
      this.statusResource.reload();
      this.inboxResource.reload();
      this.historyResource.reload();
    }, 5000);

    // Effect: Clear loading inbox when inbox data arrives
    effect(() => {
      if (this.inboxResource.status() === 'resolved') {
        this.loadingInbox.set(false);
      }
    });

    // Effect: Delta notification checking for new files
    effect(() => {
      const files = this.inboxResource.value();
      if (!files) return;

      if (this.isInitialInboxLoad) {
        this.knownFileNames = new Set(files.map((f: InboxFile) => f.filename));
        this.isInitialInboxLoad = false;
        return;
      }

      let foundNew = false;
      for (const file of files) {
        if (!this.knownFileNames.has(file.filename)) {
          foundNew = true;
          untracked(() => {
            if (this.notificationsEnabled()) {
              new Notification('File Received', {
                body: `Received "${file.filename}" (${this.formatBytes(file.size)})`,
              });
            }
          });
        }
      }
      if (foundNew) {
        this.playChime();
      }
      this.knownFileNames = new Set(files.map((f: InboxFile) => f.filename));
    });

    // Check notification permission
    if ('Notification' in window) {
      const isGranted = Notification.permission === 'granted';
      const isDisabled = localStorage.getItem('notifications_disabled') === 'true';
      this.notificationsEnabled.set(isGranted && !isDisabled);
    }
  }

  ngOnDestroy() {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }
  }

  protected requestNotificationPermission() {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        const nextState = !this.notificationsEnabled();
        this.notificationsEnabled.set(nextState);
        localStorage.setItem('notifications_disabled', String(!nextState));
      } else {
        Notification.requestPermission().then(permission => {
          const isGranted = permission === 'granted';
          this.notificationsEnabled.set(isGranted);
          localStorage.setItem('notifications_disabled', String(!isGranted));
        });
      }
    } else {
      alert('Desktop notifications are not supported by this browser.');
    }
  }

  private playChime() {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      const ctx = new AudioContextClass();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(659.25, ctx.currentTime);
      osc.frequency.setValueAtTime(880.00, ctx.currentTime + 0.12);

      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch (err) {
      console.warn('Web Audio synthesis failed:', err);
    }
  }

  protected clearHistory() {
    if (confirm('Are you sure you want to clear your transfer history logs?')) {
      this.taildropService.clearHistory().subscribe({
        next: () => this.historyResource.reload(),
        error: () => alert('Failed to clear history')
      });
    }
  }

  protected retryTransfer(log: TransferLog) {
    const destPeer = this.mergedPeers().find((p: Peer) => p.id === log.peer_id || p.hostName === log.peer_id || p.hostName.replace(' (LocalSend)', '') === log.peer_name.replace(' (LocalSend)', ''));
    if (!destPeer) {
      alert(`Cannot retry: Target device "${log.peer_name}" is no longer on the network.`);
      return;
    }
    if (!destPeer.online) {
      alert(`Cannot retry: Target device "${destPeer.hostName}" is currently offline.`);
      return;
    }

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.onchange = (event: Event) => {
      const input = event.target as HTMLInputElement;
      if (input.files && input.files.length > 0) {
        const selectedFile = input.files[0];

        if (selectedFile.name !== log.filename) {
          alert(`File mismatch: Please select "${log.filename}" (you selected "${selectedFile.name}").`);
          return;
        }
        if (selectedFile.size !== log.size) {
          alert(`File size mismatch: Please select the original "${log.filename}" of size ${this.formatBytes(log.size)}.`);
          return;
        }

        this.selectedPeerId.set(destPeer.id);
        this.addFilesToQueue([selectedFile]);

        setTimeout(() => {
          this.triggerQueueTransfer();
        }, 100);
      }
    };

    fileInput.click();
  }

  protected syncInbox() {
    this.loadingInbox.set(true);
    this.inboxResource.reload();
  }

  protected selectPeer(peer: Peer) {
    this.selectedPeerId.set(peer.id);
  }

  protected onSearchInput(event: Event) {
    const input = event.target as HTMLInputElement;
    this.searchQuery.set(input.value);
  }

  protected pingDevice(peer: Peer, event: Event) {
    event.stopPropagation();
    if (peer.pinging) return;

    this.peerLatencies.update(map => {
      const newMap = new Map(map);
      newMap.set(peer.id, { latency: null, pinging: true });
      return newMap;
    });

    this.taildropService.pingPeer(peer.hostName).subscribe({
      next: (res) => {
        this.peerLatencies.update(map => {
          const newMap = new Map(map);
          newMap.set(peer.id, {
            latency: res.latencyMs,
            pinging: false,
            curAddr: res.direct ? 'Direct' : null,
            relay: res.direct ? null : 'Relayed',
          });
          return newMap;
        });
      },
      error: (err) => {
        console.error(`Ping failed for ${peer.hostName}:`, err);
        this.peerLatencies.update(map => {
          const newMap = new Map(map);
          newMap.set(peer.id, { latency: -1, pinging: false });
          return newMap;
        });
      }
    });
  }

  protected onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const files = Array.from(input.files);
      this.addFilesToQueue(files);
      input.value = '';
    }
  }

  protected onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(true);
  }

  protected onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);
  }

  protected onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);

    if (event.dataTransfer) {
      this.handleDropFilesAndDirectories(event.dataTransfer);
    }
  }

  private async handleDropFilesAndDirectories(dataTransfer: DataTransfer) {
    const items = dataTransfer.items;
    if (!items) {
      const files = Array.from(dataTransfer.files);
      this.addFilesToQueue(files);
      return;
    }

    const promises: Promise<void>[] = [];
    const filesToQueue: File[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          if (entry.isFile) {
            promises.push(new Promise((resolve) => {
              (entry as FileSystemFileEntry).file((file) => {
                filesToQueue.push(file);
                resolve();
              }, () => resolve());
            }));
          } else if (entry.isDirectory) {
            promises.push(this.zipDirectoryEntry(entry as FileSystemDirectoryEntry));
          }
        } else {
          const file = item.getAsFile();
          if (file) filesToQueue.push(file);
        }
      }
    }

    await Promise.all(promises);
    if (filesToQueue.length > 0) {
      this.addFilesToQueue(filesToQueue);
    }
  }

  private addFilesToQueue(files: File[]) {
    const newItems: QueueItem[] = files.map(file => ({
      id: Math.random().toString(36).substring(2, 9),
      file,
      status: 'pending',
      message: ''
    }));
    this.selectedFiles.update(filesList => [...filesList, ...newItems]);
  }

  private async zipDirectoryEntry(dirEntry: FileSystemDirectoryEntry): Promise<void> {
    const zip = new JSZip();

    const queueId = Math.random().toString(36).substring(2, 9);
    this.selectedFiles.update(q => [...q, {
      id: queueId,
      file: new File([], `${dirEntry.name}.zip`),
      status: 'sending',
      message: 'Zipping folder...'
    }]);

    try {
      await this.traverseDirectory(dirEntry, '', zip);
      const content = await zip.generateAsync({ type: 'blob' });
      const zippedFile = new File([content], `${dirEntry.name}.zip`, { type: 'application/zip' });

      this.selectedFiles.update(items =>
        items.map(item => item.id === queueId ? {
          ...item,
          file: zippedFile,
          status: 'pending',
          message: 'Compressed folder'
        } : item)
      );
    } catch (err) {
      console.error('Failed to zip folder:', err);
      this.selectedFiles.update(items =>
        items.map(item => item.id === queueId ? {
          ...item,
          status: 'error',
          message: 'Compression failed'
        } : item)
      );
    }
  }

  private traverseDirectory(dirEntry: FileSystemDirectoryEntry, path: string, zip: JSZip): Promise<void> {
    return new Promise((resolve, reject) => {
      const reader = dirEntry.createReader();

      const readEntries = () => {
        reader.readEntries(async (entries) => {
          if (entries.length === 0) {
            resolve();
            return;
          }

          try {
            for (const entry of entries) {
              const relativePath = path ? `${path}/${entry.name}` : entry.name;
              if (entry.isFile) {
                await new Promise<void>((resFile, rejFile) => {
                  (entry as FileSystemFileEntry).file((file) => {
                    zip.file(relativePath, file);
                    resFile();
                  }, (err) => rejFile(err));
                });
              } else if (entry.isDirectory) {
                await this.traverseDirectory(entry as FileSystemDirectoryEntry, relativePath, zip);
              }
            }
            readEntries();
          } catch (err) {
            reject(err);
          }
        }, (err) => reject(err));
      };

      readEntries();
    });
  }

  protected removeItemFromQueue(id: string) {
    if (this.isTransferring()) return;
    this.selectedFiles.update(items => items.filter(item => item.id !== id));
  }

  protected clearQueue() {
    if (this.isTransferring()) return;
    this.selectedFiles.set([]);
  }

  protected clearCompleted() {
    if (this.isTransferring()) return;
    this.selectedFiles.update(items => items.filter(item => item.status !== 'success'));
  }

  protected triggerQueueTransfer() {
    const peer = this.selectedPeer();
    if (!peer || this.isTransferring()) return;

    const pendingItems = this.selectedFiles().filter(item => item.status === 'pending' || item.status === 'error');
    if (pendingItems.length === 0) return;

    this.isTransferring.set(true);
    this.processNextInQueue(peer.hostName, 0, pendingItems);
  }

  private processNextInQueue(targetHostName: string, index: number, items: QueueItem[]) {
    if (index >= items.length) {
      this.isTransferring.set(false);
      this.inboxResource.reload();
      return;
    }

    const item = items[index];
    this.updateItemStatus(item.id, 'sending', 'Sending...');

    this.taildropService.sendFile(targetHostName, item.file).subscribe({
      next: () => {
        this.updateItemStatus(item.id, 'success', 'Sent');
        this.processNextInQueue(targetHostName, index + 1, items);
      },
      error: (err) => {
        console.error(`Failed to transfer ${item.file.name}:`, err);
        const errMsg = err.error?.details || err.error?.error || 'Failed to send';
        this.updateItemStatus(item.id, 'error', errMsg);
        this.processNextInQueue(targetHostName, index + 1, items);
      }
    });
  }

  private updateItemStatus(id: string, status: QueueItem['status'], message: string) {
    this.selectedFiles.update(items =>
      items.map(item => item.id === id ? { ...item, status, message } : item)
    );
  }

  protected downloadFile(file: InboxFile) {
    const downloadUrl = `/api/download/${encodeURIComponent(file.filename)}`;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = file.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  protected deleteFile(file: InboxFile) {
    if (confirm(`Are you sure you want to delete ${file.filename} from this server's inbox?`)) {
      this.taildropService.deleteFile(file.filename).subscribe({
        next: () => {
          this.inboxResource.reload();
        },
        error: (err) => {
          console.error('Failed to delete file:', err);
          alert('Failed to delete file. Please try again.');
        }
      });
    }
  }

  protected extractArchive(file: InboxFile) {
    if (confirm(`Extract folder contents from archive "${file.filename}"?`)) {
      this.loadingInbox.set(true);
      this.taildropService.extractZip(file.filename).subscribe({
        next: (res) => {
          alert(res.message);
          this.inboxResource.reload();
        },
        error: (err) => {
          console.error('Failed to extract file:', err);
          alert(err.error?.details || err.error?.error || 'Failed to extract archive.');
          this.loadingInbox.set(false);
        }
      });
    }
  }

  protected formatBytes(bytes: number, decimals = 2): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  protected formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  protected isLocalSend(peer: Peer | null): boolean {
    if (!peer) return false;
    return peer.id.startsWith('localsend-') || peer.relay === 'LocalSend Protocol';
  }

  protected getOsColor(osName: string): string {
    const name = osName.toLowerCase();
    if (name.includes('mac') || name.includes('ios') || name.includes('apple') || name.includes('tvos')) {
      return 'var(--os-apple)';
    }
    if (name.includes('windows')) {
      return 'var(--os-windows)';
    }
    if (name.includes('android')) {
      return 'var(--os-android)';
    }
    if (name.includes('linux')) {
      return 'var(--os-linux)';
    }
    return 'var(--text-muted)';
  }

  protected getFileTypeDetails(filename: string): { type: string, icon: string } {
    const ext = filename.split('.').pop()?.toLowerCase() || '';

    const images = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico'];
    const videos = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv'];
    const audio = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'];
    const documents = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'json'];
    const archives = ['zip', 'rar', 'tar', 'gz', '7z'];

    if (images.includes(ext)) return { type: 'image', icon: '🎨' };
    if (videos.includes(ext)) return { type: 'video', icon: '🎬' };
    if (audio.includes(ext)) return { type: 'audio', icon: '🎵' };
    if (documents.includes(ext)) return { type: 'document', icon: '📄' };
    if (archives.includes(ext)) return { type: 'archive', icon: '📦' };
    return { type: 'generic', icon: '📁' };
  }
}
