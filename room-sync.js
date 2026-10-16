import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocFromServer, onSnapshot, runTransaction } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

const config = window.CWW_FIREBASE_CONFIG;
const appId = window.CWW_APP_ID || "constrained-word-wolf";

function dispatchReady() {
  window.dispatchEvent(new CustomEvent("cww-room-ready"));
}

function missingConfigApi() {
  return {
    configured: false,
    appId,
    userId: "",
    async ready() {
      throw new Error("Firebase設定が未投入です。firebase-config.js に Firebase Web config を設定してください。");
    }
  };
}

if (!config || !config.apiKey || !config.projectId) {
  window.CWWRoom = missingConfigApi();
  dispatchReady();
} else {
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
  let currentUser = null;

  const readyPromise = new Promise((resolve, reject) => {
    onAuthStateChanged(auth, user => {
      if (user) {
        currentUser = user;
        resolve(user);
      } else {
        signInAnonymously(auth).catch(reject);
      }
    }, reject);
  });

  function roomRef(roomCode) {
    return doc(db, "artifacts", appId, "public", "data", "rooms", roomCode);
  }

  async function ready() {
    return readyPromise;
  }

  async function createRoom(roomState) {
    await ready();
    return runTransaction(db, async transaction => {
      const ref = roomRef(roomState.roomCode);
      const snap = await transaction.get(ref);
      if (snap.exists()) return false;
      transaction.set(ref, roomState);
      return true;
    });
  }

  async function getRoom(roomCode, { server = false } = {}) {
    await ready();
    const snap = await (server ? getDocFromServer : getDoc)(roomRef(roomCode));
    return snap.exists() ? snap.data() : null;
  }

  async function mutateRoom(roomCode, mutator) {
    await ready();
    return runTransaction(db, async transaction => {
      const ref = roomRef(roomCode);
      const snap = await transaction.get(ref);
      if (!snap.exists()) throw new Error("部屋が見つかりません。");
      const state = snap.data();
      const original = JSON.stringify(state);
      const next = await mutator(JSON.parse(original));
      if (JSON.stringify(next) !== original) transaction.set(ref, next);
      return next;
    });
  }

  function subscribe(roomCode, callback, onError) {
    return onSnapshot(roomRef(roomCode), snap => {
      callback(snap.exists() ? snap.data() : null);
    }, onError);
  }

  window.CWWRoom = {
    configured: true,
    appId,
    get userId() {
      return currentUser?.uid || "";
    },
    ready,
    createRoom,
    getRoom,
    mutateRoom,
    subscribe
  };
  dispatchReady();
}
