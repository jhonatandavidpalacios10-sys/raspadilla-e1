import { initializeApp } from "firebase/app";
import {
    getFirestore,
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    collection,
    doc,
    setDoc,
    getDoc,
    getDocs,
    addDoc,
    updateDoc,
    deleteDoc,
    writeBatch,
    increment,
    serverTimestamp,
    query,
    where,
    onSnapshot,
    orderBy,
    runTransaction,
    Bytes
} from "firebase/firestore";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence, inMemoryPersistence, createUserWithEmailAndPassword, updatePassword } from "firebase/auth";

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
let db;
try {
    db = initializeFirestore(app, {
        localCache: persistentLocalCache({
            tabManager: persistentMultipleTabManager()
        })
    });
} catch (error) {
    console.warn('La caché persistente no está disponible; se usará memoria temporal.', error);
    db = getFirestore(app);
}
const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(console.error); 

const secondaryApp = initializeApp(firebaseConfig, "SecondaryAppIcePOS");
const secondaryAuth = getAuth(secondaryApp);
setPersistence(secondaryAuth, inMemoryPersistence).catch(console.warn);

export { 
    db, auth, secondaryAuth, createUserWithEmailAndPassword, updatePassword, signInWithEmailAndPassword,
    collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, 
    writeBatch, increment, serverTimestamp, query, where, onSnapshot, 
    orderBy, runTransaction, Bytes, signOut, onAuthStateChanged 
};
