// frontend/voiceEngine.js
// -----------------------------------------------------------------------
// Lightweight WebRTC mesh voice chat, signaled over the app's existing
// socket.io connection (see voice:join / voice:leave / voice:signal in
// src/server.js). No media ever passes through the server — it only
// relays offer/answer/ICE payloads between browsers. Every participant
// connects directly to every other participant, which is fine at
// friend-auction scale (a host + a handful of team owners), not meant
// for a stadium-sized call.

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

export class VoiceChat {
  constructor(socket) {
    this.socket = socket;
    this.peers = new Map(); // userId -> RTCPeerConnection (only for people we're actually connected to)
    this.rosterIds = new Set(); // everyone currently in the voice room, for UI purposes
    this.localStream = null;
    this.auctionId = null;
    this.muted = false;
    this.onChange = () => {}; // UI hook: called with { active, muted, count }

    socket.on("voice:roster", ({ peers }) => {
      for (const p of peers) {
        this.rosterIds.add(p.userId);
        this._connectTo(p.userId, true); // we joined second — we initiate to everyone already here
      }
      this._notify();
    });
    socket.on("voice:peer-joined", ({ userId }) => {
      this.rosterIds.add(userId); // they joined after us — they'll send the offer, we just wait
      this._notify();
    });
    socket.on("voice:peer-left", ({ userId }) => {
      this.rosterIds.delete(userId);
      this.peers.get(userId)?.close();
      this.peers.delete(userId);
      document.getElementById(`voice-audio-${userId}`)?.remove();
      this._notify();
    });
    socket.on("voice:signal", async ({ fromUserId, data }) => {
      const pc = this.peers.get(fromUserId) || this._createPeer(fromUserId);
      try {
        if (data.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          if (data.sdp.type === "offer") {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.socket.emit("voice:signal", { auctionId: this.auctionId, toUserId: fromUserId, data: { sdp: pc.localDescription } });
          }
        } else if (data.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      } catch (e) {
        console.error("Voice signal error (non-fatal, call continues for other peers):", e.message);
      }
    });
  }

  async join(auctionId) {
    if (this.localStream) return; // already in the call
    this.auctionId = auctionId;
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.socket.emit("voice:join", { auctionId });
    this._notify();
  }

  leave() {
    if (!this.localStream && !this.auctionId) return;
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    this.rosterIds.clear();
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    document.querySelectorAll("[id^='voice-audio-']").forEach((el) => el.remove());
    if (this.auctionId) this.socket.emit("voice:leave", { auctionId: this.auctionId });
    this.auctionId = null;
    this._notify();
  }

  toggleMute() {
    if (!this.localStream) return this.muted;
    this.muted = !this.muted;
    this.localStream.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
    this._notify();
    return this.muted;
  }

  get active() { return !!this.localStream; }
  get count() { return this.rosterIds.size; }

  _createPeer(userId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit("voice:signal", { auctionId: this.auctionId, toUserId: userId, data: { candidate: e.candidate } });
      }
    };
    pc.ontrack = (e) => {
      let audio = document.getElementById(`voice-audio-${userId}`);
      if (!audio) {
        audio = document.createElement("audio");
        audio.id = `voice-audio-${userId}`;
        audio.autoplay = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = e.streams[0];
    };
    this.peers.set(userId, pc);
    return pc;
  }

  async _connectTo(userId, isInitiator) {
    if (this.peers.has(userId)) return;
    const pc = this._createPeer(userId);
    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit("voice:signal", { auctionId: this.auctionId, toUserId: userId, data: { sdp: pc.localDescription } });
    }
  }

  _notify() {
    this.onChange({ active: this.active, muted: this.muted, count: this.count });
  }
}
