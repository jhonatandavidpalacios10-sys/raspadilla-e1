import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, enableIndexedDbPersistence, collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, writeBatch, increment, serverTimestamp, query, where, onSnapshot, orderBy, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence, inMemoryPersistence, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

const firebaseConfig = { 
    apiKey: "AIzaSyBwpV1ilLgU2ULN7ZtGIcZdBe4ccktdBzk", 
    authDomain: "raspadillas-e1.firebaseapp.com", 
    projectId: "raspadillas-e1", 
    storageBucket: "raspadillas-e1.firebasestorage.app", 
    messagingSenderId: "948259149461", 
    appId: "1:948259149461:web:fef0e94041c9e2e1b5ad9c", 
    measurementId: "G-DFHHEC5SBM" 
};

const app = initializeApp(firebaseConfig); 
const db = getFirestore(app); 
const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(console.error); 
enableIndexedDbPersistence(db).catch(console.warn);

// APP SECUNDARIA ESTRICTA (Memoria volátil para no chocar con el Admin)
const secondaryApp = initializeApp(firebaseConfig, "SecondaryAppIcePOS");
const secondaryAuth = getAuth(secondaryApp);
setPersistence(secondaryAuth, inMemoryPersistence).catch(console.warn);

export { 
    db, auth, secondaryAuth, createUserWithEmailAndPassword, 
    collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, 
    writeBatch, increment, serverTimestamp, query, where, onSnapshot, 
    orderBy, runTransaction, signInWithEmailAndPassword, signOut, onAuthStateChanged 
};
