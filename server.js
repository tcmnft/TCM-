// ============================================================================
// 🚀 TCM NFT PREMIUM BACKEND SERVER (Timezone Aware, Cached & Bulletproof)
// ============================================================================

const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const moment = require('moment-timezone');

const otplib = require('otplib');
const authenticator = otplib.authenticator || otplib;
authenticator.options = { secretSize: 10, window: 1 }; 

// 🔥 REDIS HELPER (Global Import)
const { getCache, setCache, clearUserCache } = require('./utils/redisHelper');

// =========================================================
// 🚀 MODULE 0: FIREBASE ADMIN SETUP
// =========================================================
const serviceAccount = require('./serviceAccountKey.json'); 
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const http = require('http'); // 🆕 Socket.io এর জন্য যুক্ত করা হলো
const { Server } = require('socket.io'); // 🆕 Socket.io যুক্ত করা হলো

const app = express();
const server = http.createServer(app); // 🆕 Express কে HTTP সার্ভারে র‍্যাপ করা হলো
const io = new Server(server, { cors: { origin: "*" } }); // 🆕 Socket.io ইনিশিয়ালাইজেশন

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =========================================================
// 🛠️ HELPER ENGINE: Safe Rank Evaluator & Date Parser
// =========================================================

function parseSafeTimestamp(rawDate) {
    try {
        if (!rawDate) return 0;
        if (typeof rawDate === 'object') {
            if (typeof rawDate.toDate === 'function') return rawDate.toDate().getTime();
            if (rawDate.seconds) return rawDate.seconds * 1000;
            if (rawDate._seconds) return rawDate._seconds * 1000;
        }
        if (typeof rawDate === 'number') return rawDate;
        if (typeof rawDate === 'string') {
            let d1 = new Date(rawDate).getTime();
            if (!isNaN(d1)) return d1;
            
            let parts = rawDate.split(' ');
            let dParts = parts[0].split('-');
            if (dParts.length === 3 && dParts[0].length <= 2) {
                let safeDateStr = `${dParts[1]}/${dParts[0]}/${dParts[2]}`;
                if (parts.length > 1) safeDateStr += ' ' + parts.slice(1).join(' ');
                let d2 = new Date(safeDateStr).getTime();
                if (!isNaN(d2)) return d2;
            }
        }
    } catch(e) {}
    return 0;
}

function calculateRankUpdates(uData, wData) {
    let currentRank = parseInt(uData.Rank || 0);
    let totalAssets = parseFloat(wData.Main_Balance || 0) + parseFloat(wData.Locked_Balance || 0);
    let currentPts = parseInt(wData.Points || 0);

    const LEVEL_REQ = { 
        1: { bal: 50, pts: 0 }, 2: { bal: 500, pts: 100 }, 3: { bal: 2000, pts: 200 }, 
        4: { bal: 5000, pts: 400 }, 5: { bal: 10000, pts: 500 }, 6: { bal: 20000, pts: 600 } 
    };
    let result = {};

    if (currentRank > 0) {
        let reqBalForCurrentRank = LEVEL_REQ[currentRank] ? LEVEL_REQ[currentRank].bal : 0;
        if (totalAssets < reqBalForCurrentRank) {
            let newDowngradedRank = 0;
            for (let i = currentRank - 1; i >= 1; i--) {
                if (totalAssets >= LEVEL_REQ[i].bal) { newDowngradedRank = i; break; }
            }
            result.Rank = newDowngradedRank;
            return result; 
        }
    }

    if (currentRank < 6) {
        let nextRank = currentRank + 1;
        let reqBalForNextRank = LEVEL_REQ[nextRank].bal;
        let reqPtsForNextRank = LEVEL_REQ[nextRank].pts;

        if (totalAssets >= reqBalForNextRank && currentPts >= reqPtsForNextRank) {
            result.Rank = nextRank;
            if (reqPtsForNextRank > 0) result.Points = currentPts - reqPtsForNextRank;
            return result;
        }
    }
    return result; 
}

// =========================================================
// 🗓️ TODAY'S RESERVATION & TRADE HISTORY API
// =========================================================
app.get('/api/reservation/today', async (req, res) => {
    try {
        const { uid } = req.query;
        if (!uid) return res.status(400).json({ success: false, message: "UID is required" });

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const endOfToday = new Date();
        endOfToday.setHours(23, 59, 59, 999);

        const snap = await db.collection("NFT_Transactions") 
            .where("UID", "==", uid)
            .where("timestamp", ">=", startOfToday.getTime())
            .where("timestamp", "<=", endOfToday.getTime())
            .orderBy("timestamp", "desc")
            .get();

        let todayData = [];
        snap.forEach(doc => todayData.push({ id: doc.id, ...doc.data() }));

        return res.json({ success: true, data: todayData });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// =========================================================
// 🚀 MODULE 1: AUTHENTICATION, SIGNUP, LOGIN
// =========================================================
app.post('/api/signup', async (req, res) => {
    try {
        const { name, email, password, phone, phoneRaw, country, religion, sponsor, avatar, timeZone } = req.body;
        const usersRef = db.collection("Users");

        const emailQuery = await usersRef.where("Email", "==", email.trim()).get();
        if (!emailQuery.empty) return res.status(400).json({ success: false, message: "This Email is already registered!" });

        const phoneQuery = await usersRef.where("Phone", "==", phone).get();
        if (!phoneQuery.empty) return res.status(400).json({ success: false, message: "This Phone Number is already registered!" });

        let sponsor_A = "System", sponsor_B = "System", sponsor_C = "System";
        if (sponsor && sponsor !== "SYSTEM") {
            const sponsorDoc = await usersRef.doc(sponsor).get();
            if (sponsorDoc.exists) {
                const sData = sponsorDoc.data();
                sponsor_A = sponsor; sponsor_B = sData.Sponsor_A || "System"; sponsor_C = sData.Sponsor_B || "System";
            }
        }

        const cleanPhone = phoneRaw.replace(/\D/g, '');
        let candidates = [];
        if (cleanPhone.length >= 6) {
            candidates.push(cleanPhone.slice(-6)); candidates.push(cleanPhone.slice(0, 6));
            const midStart = Math.floor(cleanPhone.length / 2) - 3;
            candidates.push(cleanPhone.slice(midStart, midStart + 6));
        }

        let finalUID = "";
        for (let cand of candidates) {
            if (cand.length === 6) {
                const snap = await usersRef.doc(`TCM${cand}`).get();
                if (!snap.exists) { finalUID = `TCM${cand}`; break; }
            }
        }

        if (!finalUID) { 
            let isUnique = false;
            while (!isUnique) {
                const randomDigits = Math.floor(100000 + Math.random() * 900000);
                finalUID = `TCM${randomDigits}`;
                const uidSnap = await usersRef.doc(finalUID).get();
                if (!uidSnap.exists) isUnique = true;
            }
        }

        const sessionToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
        const batch = db.batch();
        
        batch.set(usersRef.doc(finalUID), {
            Date: new Date().toISOString(), UID: finalUID, Name: name, Email: email.trim(), Password: password, 
            Phone: phone, Sponsor_A: sponsor_A, Sponsor_B: sponsor_B, Sponsor_C: sponsor_C, Avatar: avatar || "", 
            Wallet_BEP20: "", Wallet_TRC20: "", Security_Date: "", "2FA_Key": "", Rank: 0, Status: "Active", 
            OTP: "", Token: sessionToken, Religion: religion, Country: country,
            TimeZone: timeZone || "Asia/Kolkata"
        });

        batch.set(db.collection("Wallets").doc(finalUID), {
            UID: finalUID, Main_Balance: 0, Locked_Balance: 0, Debt: 0, Points: 0, Total_Deposit: 0, Total_Withdraw: 0, 
            Total_Earn: 0, Daily_Earn: 0, Total_Team: 0, Daily_Team: 0, Total_Stake: 0, Daily_Stake: 0, 
            Total_Reserve: 0, Daily_Reserve: 0, Total_Airdrop: 0, Daily_Airdrop: 0, Total_Comp: 0, Daily_Comp: 0,
            Last_Reset_Day: ""
        });

        await batch.commit();
        res.status(200).json({ success: true, uid: finalUID, token: sessionToken });
    } catch (error) { res.status(500).json({ success: false, message: "Registration failed." }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { identifier, password, isEmail } = req.body;
        const usersRef = db.collection("Users");
        let userDocRef, userData;

        if (isEmail) {
            const snapshot = await usersRef.where("Email", "==", identifier.trim()).get();
            if (snapshot.empty) throw new Error("User not found!");
            userDocRef = snapshot.docs[0].ref; userData = snapshot.docs[0].data();
        } else {
            userDocRef = usersRef.doc(identifier.toUpperCase().trim());
            const docSnap = await userDocRef.get();
            if (!docSnap.exists) throw new Error("Invalid UID!");
            userData = docSnap.data();
        }

        if (userData.Status === "Banned") throw new Error("Account banned.");
        if (userData.Password !== password) throw new Error("Incorrect Password!");

        const newToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
        await userDocRef.update({ Token: newToken });

        const walletSnap = await db.collection("Wallets").doc(userData.UID).get();
        res.status(200).json({ 
            success: true, uid: userData.UID, token: newToken, name: userData.Name, 
            email: userData.Email, avatar: userData.Avatar || "", timeZone: userData.TimeZone || "Asia/Kolkata", totalComp: walletSnap.exists ? walletSnap.data().Total_Comp || 0 : 0 
        });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

// =========================================================
// 🚀 MODULE 1.5: OTP & FORGOT PASSWORD ENGINE (Cache Fixed)
// =========================================================
const sendOTPEngine = async (req, res) => {
    try {
        const { uid, email } = req.body;
        let userDoc;

        if (uid) {
            userDoc = await db.collection("Users").doc(uid).get();
        } else if (email) {
            const snapshot = await db.collection("Users").where("Email", "==", email.toLowerCase().trim()).get();
            if (!snapshot.empty) userDoc = snapshot.docs[0];
        }

        if (!userDoc || !userDoc.exists) throw new Error("No account found.");

        const uData = userDoc.data();
        const generatedOTP = Math.floor(100000 + Math.random() * 900000).toString();
        await userDoc.ref.update({ OTP: generatedOTP });

        const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyY67c00zF8YN1fU0LZtju-RGOPi8wZ8KHKXkm_ciiRJmYzCrXAVJzVQuLnMJHSS-Hb/exec";
        const otpRes = await fetch(SCRIPT_URL, {
            method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action: "sendEmailOTP", email: uData.Email, name: uData.Name, otp: generatedOTP })
        });
        
        const otpData = await otpRes.json();
        if (!otpData.success) throw new Error("OTP email sending failed.");

        res.status(200).json({ success: true, uid: uData.UID, message: "OTP sent successfully!" });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
};

app.post('/api/auth/send-otp', sendOTPEngine);
app.post('/api/forgot-password/send-otp', sendOTPEngine);
app.post('/api/security/send-otp', sendOTPEngine);

app.post('/api/forgot-password/reset', async (req, res) => {
    try {
        const { uid, enteredOTP, newPass } = req.body;
        const userRef = db.collection("Users").doc(uid);
        const userSnap = await userRef.get();
        
        if (!userSnap.exists) throw new Error("User error. Please try again.");
        if (userSnap.data().OTP !== enteredOTP) throw new Error("Invalid OTP!");

        const newToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
        await userRef.update({ Password: newPass, OTP: "", Token: newToken });
        
        await clearUserCache(uid); // 🔥 BUG FIXED: Cache cleared on password reset
        res.status(200).json({ success: true, message: "Password updated successfully!" });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

// =========================================================
// 🚀 MODULE 2: SECURITY ENGINE (BINDING 2FA & WALLET)
// =========================================================
app.post('/api/auth/generate-2fa', async (req, res) => {
    try {
        const secret = authenticator.generateSecret();
        const issuer = encodeURIComponent('TCM NFT');
        const account = encodeURIComponent(req.body.uid);
        res.json({ success: true, secret, otpauth: `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}` });
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
});

const bind2FAEngine = async (req, res) => {
    try {
        const uid = req.body.uid;
        const otp = req.body.otp || req.body.emailOTP;
        const code = req.body.code || req.body.code2FA;
        const secret = req.body.secret || req.body.secretKey;

        const userRef = db.collection("Users").doc(uid);
        const userSnap = await userRef.get();
        
        if (!userSnap.exists || userSnap.data().OTP !== otp) throw new Error("Invalid or Expired Email OTP!");
        if (!authenticator.verify({ token: code, secret: secret })) throw new Error("Invalid Authenticator Code!");
        
        await userRef.update({ "2FA_Key": secret, OTP: "", Security_Date: FieldValue.serverTimestamp() });
        await clearUserCache(uid); 
        res.json({ success: true, message: "Google 2FA Bound Successfully!" });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
app.post('/api/auth/bind-2fa', bind2FAEngine);
app.post('/api/security/bind-2fa', bind2FAEngine); 

const unbind2FAEngine = async (req, res) => {
    try {
        const uid = req.body.uid;
        const password = req.body.password;
        const otp = req.body.otp || req.body.emailOTP;

        const userRef = db.collection("Users").doc(uid);
        const userSnap = await userRef.get();
        
        if (userSnap.data().Password !== password) throw new Error("Incorrect Password!");
        if (userSnap.data().OTP !== otp) throw new Error("Invalid or Expired Email OTP!");
        
        await userRef.update({ "2FA_Key": "", OTP: "", Security_Date: FieldValue.serverTimestamp() });
        await clearUserCache(uid); 
        res.json({ success: true, message: "Google 2FA Unbound!" });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
app.post('/api/auth/unbind-2fa', unbind2FAEngine);
app.post('/api/security/unbind-2fa', unbind2FAEngine); 

const bindWalletEngine = async (req, res) => {
    try {
        const uid = req.body.uid;
        const network = req.body.network || req.body.net;
        const address = req.body.address;
        const otp = req.body.otp || req.body.emailOTP;
        const code = req.body.code || req.body.code2FA;

        const userRef = db.collection("Users").doc(uid);
        const userSnap = await userRef.get();
        const uData = userSnap.data();
        
        if (!uData["2FA_Key"] || !authenticator.verify({ token: code, secret: uData["2FA_Key"] })) throw new Error("Invalid 2FA Code!");
        if (uData.OTP !== otp) throw new Error("Invalid Email OTP!");
        
        const updateData = { Security_Date: FieldValue.serverTimestamp(), OTP: "" };
        if (network === 'BEP20') updateData.Wallet_BEP20 = address;
        if (network === 'TRC20') updateData.Wallet_TRC20 = address;

        await userRef.update(updateData);
        await clearUserCache(uid); 
        res.json({ success: true, message: "Wallet Bound Successfully!" });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
app.post('/api/auth/bind-wallet', bindWalletEngine);
app.post('/api/security/bind-wallet', bindWalletEngine); 

// =========================================================
// 🚀 MODULE 3: FINANCE ENGINE (🔥 NEGATIVE EXPLOIT FIXED)
// =========================================================
app.post('/api/finance/check-security-lock', async (req, res) => {
    try {
        const { uid } = req.body;
        const uSnap = await db.collection("Users").doc(uid).get();
        const uData = uSnap.data();
        
        if (uData.Security_Date) {
            let secDate = uData.Security_Date.toDate();
            let targetTime = secDate.getTime() + (72 * 3600000);
            if (Date.now() < targetTime) return res.json({ success: false, isLocked: true, targetTime });
        }
        res.json({ success: true, isLocked: false });
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
});

app.get('/api/finance/monthly-quota', async (req, res) => {
    try {
        const uid = req.query.uid;
        const snap = await db.collection("Transactions").where("UID", "==", uid).get();
        let count = 0;
        const currentMonth = new Date().getMonth();
        const currentYear = new Date().getFullYear();
        
        snap.forEach(doc => {
            const data = doc.data();
            if(data.Type === 'Withdraw' || data.Type === 'P2P Sent') {
                let docTime = parseSafeTimestamp(data.timestamp || data.Date);
                let txDate = new Date(docTime);
                if(txDate.getMonth() === currentMonth && txDate.getFullYear() === currentYear) count++;
            }
        });
        res.json({ success: true, count });
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
});

app.post('/api/finance/deposit', async (req, res) => {
    try {
        const uid = req.body.uid;
        const amount = parseFloat(req.body.amount);
        const txid = req.body.txid || req.body.txHash;
        
        if (isNaN(amount) || amount <= 0) throw new Error("Invalid Amount!"); // 🔥 BUG FIXED: Negative exploit

        await db.collection("Transactions").add({ 
            Date: new Date().toISOString(), UID: uid, Type: "Deposit", Amount: amount, TXID: txid, Status: "Pending", 
            Order_ID: "DEP" + Math.floor(100000 + Math.random()*900000), timestamp: FieldValue.serverTimestamp() 
        });
        await clearUserCache(uid); 
        res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

app.post('/api/finance/withdraw', async (req, res) => {
    try {
        const uid = req.body.uid;
        const network = req.body.network || req.body.net;
        const amount = parseFloat(req.body.amount); // 🔥 BUG FIXED: String Trap Avoided
        const code2FA = req.body.code2FA || req.body.code;
        const address = req.body.address || req.body.boundAddr;

        if (isNaN(amount) || amount <= 0) throw new Error("Invalid Amount!"); // 🔥 BUG FIXED: Negative exploit

        await db.runTransaction(async (t) => {
            const uRef = db.collection("Users").doc(uid);
            const wRef = db.collection("Wallets").doc(uid);
            
            const uData = (await t.get(uRef)).data();
            const wData = (await t.get(wRef)).data();

            if (!uData["2FA_Key"]) throw new Error("Please bind Google 2FA first!");
            let is2FAValid = false;
            try {
                is2FAValid = authenticator.verify({ token: String(code2FA), secret: uData["2FA_Key"] });
            } catch(err) {
                if (typeof authenticator.check === 'function') is2FAValid = authenticator.check(String(code2FA), uData["2FA_Key"]);
            }
            if (!is2FAValid) throw new Error("Invalid 2FA Code!");

            if (uData.Security_Date && new Date().getTime() < uData.Security_Date.toDate().getTime() + (72 * 3600000)) throw new Error("72H Lock Active!");
            if (parseFloat(wData.Main_Balance || 0) < amount) throw new Error("Insufficient Balance!");

            // 🔥 HEALTH PROTOCOL VALIDATION
            let tDep = parseFloat(wData.Total_Deposit || 0);
            let tWd = parseFloat(wData.Total_Withdraw || 0);
            let tTeamDep = parseFloat(wData.Total_Team_Deposit || 0);
            
            let health = 100;
            if (tWd > 0) {
                let rawRatio = (tDep + (tTeamDep * 0.10)) / tWd;
                health = Math.floor(Math.min(100, Math.max(0, rawRatio * 100)));
            }
            if (tWd > tDep && tTeamDep < 100) health = Math.min(health, 35);
            
            if (health < 40) {
                throw new Error("Health Protocol Active. Your ecosystem needs new deposits to process further withdrawals.");
            }
            if (health >= 40 && health <= 49) {
                if (amount !== 25) {
                    throw new Error(`Emergency Quota Active: You can only withdraw exactly $25. Your health is ${health}%.`);
                }
            }

            let fee = amount >= 100 ? amount * 0.05 : 2;
            let netAmount = amount - fee;
            let newMainBal = parseFloat(wData.Main_Balance) - amount;
            
            let wUpdates = { Main_Balance: newMainBal, Total_Withdraw: parseFloat(wData.Total_Withdraw || 0) + amount };
            let uUpdates = {};

            let rankRes = calculateRankUpdates(uData, { ...wData, Main_Balance: newMainBal });
            if (rankRes.Rank !== undefined) uUpdates.Rank = rankRes.Rank;
            if (rankRes.Points !== undefined) wUpdates.Points = rankRes.Points;

            t.update(wRef, wUpdates);
            if (Object.keys(uUpdates).length > 0) t.update(uRef, uUpdates);
            
            t.set(db.collection("Transactions").doc(), { 
                Date: new Date().toISOString(), UID: uid, Type: "Withdraw", Amount: amount, Fee: fee, Net_Amount: netAmount, 
                Network: network, Destination: address, Status: "Pending", Order_ID: "WD" + Math.floor(100000 + Math.random()*900000), timestamp: FieldValue.serverTimestamp() 
            });
        });
        await clearUserCache(uid);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// =========================================================
// 🚀 MODULE 4: P2P TRANSFER & HISTORY
// =========================================================
app.post('/api/p2p/read-glow', async (req, res) => {
    try {
        await db.collection("Users").doc(req.body.uid).update({ hasUnreadP2P: false });
        res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

app.get('/api/p2p/check-user', async (req, res) => {
    try {
        const snap = await db.collection("Users").where("UID", "==", req.query.uid).limit(1).get();
        if (snap.empty) throw new Error("User not found!");
        res.json({ success: true, name: snap.docs[0].data().Name });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

const p2pTransferEngine = async (req, res) => {
    try {
        const senderUid = req.body.senderUid || req.body.sUid;
        const receiverUid = req.body.receiverUid || req.body.rUid;
        const amount = parseFloat(req.body.amount);
        const code2FA = req.body.code2FA;
        const customOrderId = "ORDP2" + Math.random().toString(36).substr(2, 6).toUpperCase() + "P";
        
        if (isNaN(amount) || amount <= 0) throw new Error("Invalid Amount!"); // 🔥 BUG FIXED: Negative exploit & String
        
        let finalFee = 0, sName = "", rName = "";

        await db.runTransaction(async (t) => {
            const sUserRef = db.collection("Users").doc(senderUid);
            const sData = (await t.get(sUserRef)).data();
            sName = sData.Name || "User";

            if (!sData["2FA_Key"]) throw new Error("Please bind Google 2FA first!");
            let is2FAValid = false;
            try { is2FAValid = authenticator.verify({ token: String(code2FA), secret: sData["2FA_Key"] }); } catch(err) {}
            if (!is2FAValid) throw new Error("Invalid 2FA Code!");
            
            const rUserQuerySnap = await t.get(db.collection("Users").where("UID", "==", receiverUid));
            if (rUserQuerySnap.empty) throw new Error("Receiver not found!");
            const rDoc = rUserQuerySnap.docs[0];
            const rUserRef = rDoc.ref;
            const rData = rDoc.data();
            rName = rData.Name || "User";
            
            const sWalletRef = db.collection("Wallets").doc(senderUid);
            const rWalletRef = db.collection("Wallets").doc(rDoc.id);
            const sWSnap = await t.get(sWalletRef);
            const rWSnap = await t.get(rWalletRef);
            
            const sMainBal = parseFloat(sWSnap.data().Main_Balance || 0);
            if (sMainBal < amount) throw new Error("Insufficient Balance!");

            let fee = amount * 0.05;
            finalFee = fee;
            let netAmt = amount - fee;
            let newSenderBal = sMainBal - amount;
            let newReceiverBal = parseFloat(rWSnap.data().Main_Balance || 0) + netAmt;
            
            let sWalletUpdates = { Main_Balance: newSenderBal };
            let rWalletUpdates = { Main_Balance: newReceiverBal };
            let sUserUpdates = {};
            let rUserUpdates = { hasUnreadP2P: true };

            let sRankCalc = calculateRankUpdates(sData, { ...sWSnap.data(), Main_Balance: newSenderBal });
            if (sRankCalc.Rank !== undefined) sUserUpdates.Rank = sRankCalc.Rank;
            if (sRankCalc.Points !== undefined) sWalletUpdates.Points = sRankCalc.Points;

            let rRankCalc = calculateRankUpdates(rData, { ...rWSnap.data(), Main_Balance: newReceiverBal });
            if (rRankCalc.Rank !== undefined) rUserUpdates.Rank = rRankCalc.Rank;
            if (rRankCalc.Points !== undefined) rWalletUpdates.Points = rRankCalc.Points;

            if(Object.keys(sUserUpdates).length > 0) t.update(sUserRef, sUserUpdates);
            t.update(sWalletRef, sWalletUpdates);
            t.update(rUserRef, rUserUpdates);
            t.update(rWalletRef, rWalletUpdates);

            const txDateIso = new Date().toISOString();
            t.set(db.collection("Send_Money_P2P").doc(), { Date: txDateIso, Sender_UID: senderUid, Sender_Name: sName, Receiver_UID: receiverUid, Receiver_Name: rName, Amount: amount, Fee: fee, Net_Amount: netAmt, Order_ID: customOrderId, Status: "Success", timestamp: FieldValue.serverTimestamp() });
            t.set(db.collection("Transactions").doc(), { Date: txDateIso, UID: senderUid, Type: "P2P Sent", Amount: amount, Status: "Success", Order_ID: customOrderId, Admin_Remarks: `To: ${rName} (UID: ${receiverUid})`, timestamp: FieldValue.serverTimestamp() });
            t.set(db.collection("Transactions").doc(), { Date: txDateIso, UID: receiverUid, Type: "P2P Received", Amount: netAmt, Status: "Success", Order_ID: customOrderId, Admin_Remarks: `From: ${sName} (UID: ${senderUid})`, timestamp: FieldValue.serverTimestamp() });
        });
        
        await clearUserCache(senderUid); await clearUserCache(receiverUid);
        res.json({ success: true, data: { orderId: customOrderId, fee: finalFee, senderName: sName, receiverName: rName } });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
app.post('/api/p2p/transfer', p2pTransferEngine);
app.post('/api/finance/p2p', p2pTransferEngine); 

app.get('/api/p2p/lookup', async (req, res) => {
    try {
        const snap = await db.collection("Send_Money_P2P").where("Order_ID", "==", req.query.orderId).limit(1).get();
        if (snap.empty) throw new Error("Order ID not found!");
        res.json({ success: true, data: snap.docs[0].data() });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

app.get('/api/p2p/history', async (req, res) => {
    try {
        const uid = req.query.uid;
        const qSender = db.collection("Send_Money_P2P").where("Sender_UID", "==", uid).get();
        const qReceiver = db.collection("Send_Money_P2P").where("Receiver_UID", "==", uid).get();
        const [snapSender, snapReceiver] = await Promise.all([qSender, qReceiver]);
        
        let historyArr = [];
        snapSender.forEach(d => historyArr.push({ ...d.data(), isSender: true }));
        snapReceiver.forEach(d => historyArr.push({ ...d.data(), isSender: false }));
        
        historyArr.sort((a, b) => parseSafeTimestamp(b.timestamp || b.Date) - parseSafeTimestamp(a.timestamp || a.Date));
        res.json({ success: true, data: historyArr });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// =========================================================
// 🚀 MODULE 5: NFT ENGINE (🔥 NFT Timezone Bug Fixed)
// =========================================================
const LEVEL_PROFIT_RATES = {0: 0.000, 1: 0.013, 2: 0.018, 3: 0.023, 4: 0.028, 5: 0.033, 6: 0.038};

app.get('/api/nft/market', async (req, res) => {
    try {
        const cacheKey = `global_nft_market`;
        const cachedMarket = await getCache(cacheKey);
        if (cachedMarket) return res.json({ success: true, source: 'redis', data: cachedMarket });

        const snap = await db.collection("NFT_Gallery").where("Status", "==", "Available").get();
        let marketList = [];
        snap.forEach(doc => marketList.push({ id: doc.id, ...doc.data() }));

        await setCache(cacheKey, marketList, 86400); 
        res.json({ success: true, source: 'db', data: marketList });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

app.get('/api/nft/history', async (req, res) => {
    try {
        const { uid } = req.query;
        if (!uid) throw new Error("UID required");

        const cacheKey = `nft_history_full_${uid}`;
        const cachedData = await getCache(cacheKey);
        if (cachedData) return res.json({ success: true, source: 'redis', data: cachedData });

        const snap = await db.collection("NFT_History").where("UID", "==", uid).get();
        let historyArr = [];
        snap.forEach(d => historyArr.push({ id: d.id, ...d.data() }));

        historyArr.sort((a, b) => parseSafeTimestamp(b.timestamp || b.Date) - parseSafeTimestamp(a.timestamp || a.Date));

        await setCache(cacheKey, historyArr, 300); 
        res.json({ success: true, source: 'db', data: historyArr });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

app.post('/api/nft/reserve', async (req, res) => {
    try {
        const { uid, level } = req.body;
        
        // 🔥 BUG FIXED: Smart Timezone calculation instead of UTC 'new Date()'
        const tz = "Asia/Kolkata";
        let userLocalTime = moment().tz(tz);
        let boundaryTime = userLocalTime.clone().hours(5).minutes(30).seconds(0).milliseconds(0);
        
        if (userLocalTime.isBefore(boundaryTime)) {
            boundaryTime.subtract(1, 'days');
        }

        const historySnap = await db.collection("NFT_History").where("UID", "==", uid).where("Type", "==", "NFT Reserve").get();
        let hasReservedToday = false;
        
        historySnap.forEach((doc) => { 
            let docTime = parseSafeTimestamp(doc.data().timestamp || doc.data().Date);
            if (docTime >= boundaryTime.valueOf()) hasReservedToday = true;
        });
        
        if (hasReservedToday) throw new Error("Daily Limit Reached! You have already reserved an NFT today.");

        const nftSnap = await db.collection("NFT_Gallery").where("Level", "==", level.toString()).where("Status", "==", "Available").limit(1).get();
        if (nftSnap.empty) throw new Error("Network busy! No available NFT found for this level.");
        
        const nftDoc = nftSnap.docs[0];
        const nftData = nftDoc.data();
        const orderId = "ORD" + Math.floor(100000 + Math.random()*900000) + "LX";

        await db.runTransaction(async (t) => {
            const wRef = db.collection("Wallets").doc(uid);
            const wSnap = await t.get(wRef);
            const nSnap = await t.get(nftDoc.ref);
            
            if (!wSnap.exists || nSnap.data().Status !== "Available") throw new Error("NFT unavailable.");
            
            const price = parseFloat(nSnap.data().Price);
            const bal = parseFloat(wSnap.data().Main_Balance || 0);
            if (bal < price) throw new Error(`Insufficient Balance. Need ${price} ₮`);
            
            t.update(wRef, { Main_Balance: bal - price, Locked_Balance: parseFloat(wSnap.data().Locked_Balance || 0) + price });
            t.update(nftDoc.ref, { Status: "Reserved", Owner_UID: uid });
            t.update(db.collection("Users").doc(uid), { "counters.txCount": FieldValue.increment(1), "counters.activeReservations": FieldValue.increment(1) });
            
            t.set(db.collection("NFT_History").doc(), { 
                Date: new Date().toISOString(), UID: uid, Type: "NFT Reserve", Amount: price, Order_ID: orderId, Details: "Reserved NFT", NFT_ID: nftData.NFT_ID || nftData.Name || "Unknown NFT", Image_URL: nftData.Image_URL || nftData.image || "https://i.ibb.co/3sZxCqT/nft-placeholder.jpg", docId: nftDoc.id, NFT_Level: level, timestamp: FieldValue.serverTimestamp() 
            });
        });
        
        await clearUserCache(uid); 
        res.json({ success: true, nftData: { id: nftData.NFT_ID || nftData.Name || "Unknown NFT", price: parseFloat(nftData.Price), img: nftData.Image_URL || nftData.image || "https://i.ibb.co/3sZxCqT/nft-placeholder.jpg", orderId: orderId, docId: nftDoc.id, level: level }});
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

app.post('/api/nft/sell', async (req, res) => {
    try {
        const { uid, docId, orderId } = req.body; 
        let receiptData = {};
        
        await db.runTransaction(async (t) => {
            const uSnap = await t.get(db.collection("Users").doc(uid));
            const wSnap = await t.get(db.collection("Wallets").doc(uid));
            const nSnap = await t.get(db.collection("NFT_Gallery").doc(docId));
            
            if(!wSnap.exists || !uSnap.exists || !nSnap.exists || nSnap.data().Owner_UID !== uid || nSnap.data().Status !== "Reserved") throw new Error("NFT unavailable to sell.");

            const uD = uSnap.data(); const wD = wSnap.data(); const nftData = nSnap.data();
            
            const spA = uD.Sponsor_A ? await t.get(db.collection("Wallets").doc(uD.Sponsor_A)) : null;
            const spB = uD.Sponsor_B ? await t.get(db.collection("Wallets").doc(uD.Sponsor_B)) : null;
            const spC = uD.Sponsor_C ? await t.get(db.collection("Wallets").doc(uD.Sponsor_C)) : null;

            const principal = parseFloat(nftData.Price);
            const level = parseInt(nftData.Level || 1);
            const gross = parseFloat((principal * (LEVEL_PROFIT_RATES[level] || 0)).toFixed(2));
            const fee = parseFloat((gross * 0.21).toFixed(2));
            const net = parseFloat((gross - fee).toFixed(2));
            const ret = principal + net;
            receiptData = { principal, net, ret, fee, gross };

            let newMainBal = parseFloat(wD.Main_Balance || 0) + ret;
            let newLockedBal = Math.max(0, parseFloat(wD.Locked_Balance || 0) - principal);

            let wUpdates = {
                Main_Balance: newMainBal, Locked_Balance: newLockedBal,
                Total_Reserve: parseFloat(wD.Total_Reserve || 0) + net, Daily_Reserve: parseFloat(wD.Daily_Reserve || 0) + net,
                Total_Comp: parseFloat(wD.Total_Comp || 0) + net, Daily_Comp: parseFloat(wD.Daily_Comp || 0) + net
            };
            let uUpdates = {};

            let rankRes = calculateRankUpdates(uD, { ...wD, Main_Balance: newMainBal, Locked_Balance: newLockedBal });
            if (rankRes.Rank !== undefined) uUpdates.Rank = rankRes.Rank;
            if (rankRes.Points !== undefined) wUpdates.Points = rankRes.Points;

            uUpdates["counters.txCount"] = FieldValue.increment(1);
            uUpdates["counters.activeReservations"] = FieldValue.increment(-1);

            t.update(wSnap.ref, wUpdates);
            if (Object.keys(uUpdates).length > 0) t.update(uSnap.ref, uUpdates);

            const txDateIso = new Date().toISOString();
            const senderDetails = `${uD.Name || 'User'} (UID: ${uid})`;
            const finalOrderId = orderId || ("ORD" + Math.floor(100000 + Math.random()*900000) + "LX");

            if(spA && spA.exists) { 
                let earnA = parseFloat((gross * 0.12).toFixed(2)); 
                t.update(spA.ref, { Main_Balance: parseFloat(spA.data().Main_Balance||0) + earnA, Total_Team: parseFloat(spA.data().Total_Team||0) + earnA, Daily_Team: parseFloat(spA.data().Daily_Team||0) + earnA }); 
                t.set(db.collection("Transactions").doc(), { Date: txDateIso, UID: spA.id, Type: "Team Bonus (A-Hand)", Amount: earnA, Status: "Success", Order_ID: finalOrderId, Admin_Remarks: `From: ${senderDetails}`, timestamp: FieldValue.serverTimestamp() }); 
                clearUserCache(spA.id);
            }
            if(spB && spB.exists) { 
                let earnB = parseFloat((gross * 0.06).toFixed(2)); 
                t.update(spB.ref, { Main_Balance: parseFloat(spB.data().Main_Balance||0) + earnB, Total_Team: parseFloat(spB.data().Total_Team||0) + earnB, Daily_Team: parseFloat(spB.data().Daily_Team||0) + earnB }); 
                t.set(db.collection("Transactions").doc(), { Date: txDateIso, UID: spB.id, Type: "Team Bonus (B-Hand)", Amount: earnB, Status: "Success", Order_ID: finalOrderId, Admin_Remarks: `From: ${senderDetails}`, timestamp: FieldValue.serverTimestamp() }); 
                clearUserCache(spB.id);
            }
            if(spC && spC.exists) { 
                let earnC = parseFloat((gross * 0.03).toFixed(2)); 
                t.update(spC.ref, { Main_Balance: parseFloat(spC.data().Main_Balance||0) + earnC, Total_Team: parseFloat(spC.data().Total_Team||0) + earnC, Daily_Team: parseFloat(spC.data().Daily_Team||0) + earnC }); 
                t.set(db.collection("Transactions").doc(), { Date: txDateIso, UID: spC.id, Type: "Team Bonus (C-Hand)", Amount: earnC, Status: "Success", Order_ID: finalOrderId, Admin_Remarks: `From: ${senderDetails}`, timestamp: FieldValue.serverTimestamp() }); 
                clearUserCache(spC.id);
            }

            t.update(nSnap.ref, { Status: "Cooldown", Owner_UID: "", Next_Available_Time: new Date().getTime() + 120000 });
            t.set(db.collection("NFT_History").doc(), { Date: txDateIso, UID: uid, Type: "NFT Sold", Amount: ret, Order_ID: finalOrderId, Details: `Gross: ${gross} | Fee: -${fee} | Net: +${net}`, NFT_ID: nftData.NFT_ID || nftData.Name || "Unknown NFT", Image_URL: nftData.Image_URL || nftData.image || "https://i.ibb.co/3sZxCqT/nft-placeholder.jpg", timestamp: FieldValue.serverTimestamp() });
            t.set(db.collection("Transactions").doc(), { Date: txDateIso, UID: uid, Type: "NFT Profit", Amount: net, Status: "Success", Order_ID: finalOrderId, timestamp: FieldValue.serverTimestamp() });
        });

        await clearUserCache(uid); 
        res.json({ success: true, data: receiptData });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// =========================================================
// 🚀 MODULE 6: PROFILE, DASHBOARD INIT (🔥 Lazy Reset & Health Engine)
// =========================================================
app.get('/api/user/init-data', async (req, res) => {
    try {
        const uid = req.query.uid;
        if (!uid) throw new Error("UID is required");

        const cacheKey = `init_data_full_${uid}`;
        let cachedData = await getCache(cacheKey);
        
        let tz = "Asia/Kolkata";
        if (cachedData && cachedData.user && cachedData.user.TimeZone) tz = cachedData.user.TimeZone;

        let userLocalTime = moment().tz(tz);
        
        const h = userLocalTime.hours();
        const m = userLocalTime.minutes();
        const isResetWindow = (h === 5 && m >= 28 && m <= 32);

        let resetBoundary = userLocalTime.clone().hours(5).minutes(30).seconds(0).milliseconds(0);
        if (userLocalTime.isBefore(resetBoundary)) resetBoundary.subtract(1, 'days');
        let activeResetDate = resetBoundary.format("YYYY-MM-DD");

        if (isResetWindow || (cachedData && cachedData.wallet.Last_Reset_Day !== activeResetDate)) {
            cachedData = null; 
        }

        if (cachedData && !isResetWindow) return res.json({ success: true, source: 'redis_cache', data: cachedData });

        const [userDoc, walletDoc, txSnap] = await Promise.all([
            db.collection("Users").doc(uid).get(), 
            db.collection("Wallets").doc(uid).get(),
            db.collection("Transactions").where("UID", "==", uid).get()
        ]);

        if (!userDoc.exists || !walletDoc.exists) throw new Error("Account data not found.");

        let userData = userDoc.data();
        let walletData = walletDoc.data();

        tz = userData.TimeZone || "Asia/Kolkata";
        userLocalTime = moment().tz(tz);
        resetBoundary = userLocalTime.clone().hours(5).minutes(30).seconds(0).milliseconds(0);
        if (userLocalTime.isBefore(resetBoundary)) resetBoundary.subtract(1, 'days');
        activeResetDate = resetBoundary.format("YYYY-MM-DD");

        if (walletData.Last_Reset_Day !== activeResetDate) {
            const resetFields = {
                Daily_Earn: 0, Daily_Reserve: 0, Daily_Team: 0, 
                Daily_Stake: 0, Daily_Airdrop: 0, Daily_Comp: 0, 
                Last_Reset_Day: activeResetDate 
            };
            await db.collection("Wallets").doc(uid).update(resetFields);
            walletData = { ...walletData, ...resetFields }; 
        }

        let tDep = parseFloat(walletData.Total_Deposit || 0);
        let tWd = parseFloat(walletData.Total_Withdraw || 0);
        let tTeamDep = parseFloat(walletData.Total_Team_Deposit || 0);
        
        let healthScore = 100;
        if (tWd > 0) {
            let rawRatio = (tDep + (tTeamDep * 0.10)) / tWd;
            healthScore = Math.floor(Math.min(100, Math.max(0, rawRatio * 100)));
        }
        if (tWd > tDep && tTeamDep < 100) healthScore = Math.min(healthScore, 35);
        walletData.Health_Score = healthScore; 

        let txs = [];
        txSnap.forEach(d => txs.push(d.data()));
        txs.sort((a, b) => parseSafeTimestamp(b.timestamp || b.Date) - parseSafeTimestamp(a.timestamp || a.Date));

        userData.counters = userData.counters || { txCount: 1, teamCount: 1, activeReservations: 1, unreadP2P: 0 };

        const responsePayload = { user: userData, wallet: walletData, transactions: txs, serverTime: Date.now() };

        if (!isResetWindow) await setCache(cacheKey, responsePayload, 300); 
        res.json({ success: true, source: 'firestore_db', data: responsePayload });
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
});

// =========================================================
// 🌐 MODULE 6.5: GLOBAL LIVE FEED ENGINE (Zero-Billing & Avatar Sync)
// =========================================================
app.get('/api/feed/global', async (req, res) => {
    try {
        const cacheKey = 'global_live_feed';
        const cachedFeed = await getCache(cacheKey);
        if (cachedFeed) return res.json({ success: true, source: 'redis', data: cachedFeed });

        const snap = await db.collection("Transactions").orderBy("timestamp", "desc").limit(40).get();
        let tempFeed = [];
        const validTypes = ["Deposit", "Withdraw", "P2P Sent", "P2P Received"];
        let uidsToFetch = new Set();
        
        snap.forEach(doc => {
            const data = doc.data();
            if (validTypes.includes(data.Type)) {
                tempFeed.push(data);
                if (data.UID) uidsToFetch.add(data.UID);
            }
        });

        let userAvatars = {};
        for (let uid of uidsToFetch) {
            let avCacheKey = `avatar_${uid}`;
            let cachedAv = await getCache(avCacheKey);
            if (cachedAv) {
                userAvatars[uid] = cachedAv; 
            } else {
                let uDoc = await db.collection("Users").doc(uid).get();
                if (uDoc.exists) {
                    let avUrl = uDoc.data().Avatar || "";
                    userAvatars[uid] = avUrl;
                    await setCache(avCacheKey, avUrl, 86400); 
                }
            }
        }

        const feedWithAvatars = tempFeed.map(tx => ({ ...tx, Avatar: userAvatars[tx.UID] || "" }));
        const finalFeed = feedWithAvatars.slice(0, 20);
        await setCache(cacheKey, finalFeed, 15); 
        res.json({ success: true, source: 'db', data: finalFeed });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// =========================================================
// 🚀 MODULE 7: TEAM & NETWORK ENGINE
// =========================================================
app.get('/api/team/network', async (req, res) => {
    try {
        const uid = req.query.uid;
        const cacheKey = `team_network_full_${uid}`;
        const cachedData = await getCache(cacheKey);
        if (cachedData) return res.json({ success: true, source: 'redis', data: cachedData });

        const fetchHand = async (sponsorField) => {
            const userSnap = await db.collection("Users").where(sponsorField, "==", uid).get();
            let childUids = [];
            let userMap = {};

            userSnap.forEach(doc => {
                const uData = doc.data(); 
                const childUid = uData.UID || doc.id; 
                childUids.push(childUid);
                userMap[childUid] = { name: uData.Name || 'TCM User', uid: childUid, rank: uData.Rank || 0, balance: 0 };
            });

            if (childUids.length === 0) return { count: 0, volume: 0, users: [] };

            const chunkSize = 30;
            const uidChunks = [];
            for (let i = 0; i < childUids.length; i += chunkSize) uidChunks.push(childUids.slice(i, i + chunkSize));

            const walletPromises = uidChunks.map(chunk => db.collection("Wallets").where("UID", "in", chunk).get());
            const walletSnaps = await Promise.all(walletPromises);
            
            let totalVolume = 0;
            walletSnaps.forEach(snap => {
                snap.forEach(doc => {
                    const wData = doc.data();
                    const wUid = wData.UID || doc.id;
                    const balance = parseFloat(wData.Main_Balance || 0);
                    
                    if (userMap[wUid]) { 
                        userMap[wUid].balance = balance; 
                        // 🔥 নতুন ডেটা যুক্ত করা হলো
                        userMap[wUid].totalDeposit = parseFloat(wData.Total_Deposit || 0);
                        userMap[wUid].totalEarn = parseFloat(wData.Total_Comp || wData.Total_Earn || 0);
                        userMap[wUid].totalWithdraw = parseFloat(wData.Total_Withdraw || 0);
                        
                        totalVolume += balance; 
                    }
                });
            });

            const users = Object.values(userMap);
            return { count: users.length, volume: totalVolume, users };
        };
        
        const [handA, handB, handC] = await Promise.all([ fetchHand("Sponsor_A"), fetchHand("Sponsor_B"), fetchHand("Sponsor_C") ]);
        const teamData = { handA, handB, handC };
        
        await setCache(cacheKey, teamData, 300);
        res.json({ success: true, source: 'db', data: teamData });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

app.get('/api/team/bonuses', async (req, res) => {
    try {
        const uid = req.query.uid;
        const cacheKey = `team_bonuses_${uid}`;
        const cachedData = await getCache(cacheKey);
        if (cachedData) return res.json({ success: true, source: 'redis', data: cachedData });

        const bonusTypes = ["Team Bonus (A-Hand)", "Team Bonus (B-Hand)", "Team Bonus (C-Hand)"];
        const snap = await db.collection("Transactions").where("UID", "==", uid).where("Type", "in", bonusTypes).get();

        let bonuses = [];
        snap.forEach(d => bonuses.push(d.data()));
        bonuses.sort((a, b) => parseSafeTimestamp(b.timestamp || b.Date) - parseSafeTimestamp(a.timestamp || a.Date));

        await setCache(cacheKey, bonuses, 300);
        res.json({ success: true, data: bonuses });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// ============================================================================
// 💬 MODULE 8: CHAT ENGINE & FRIENDS
// ============================================================================
app.post('/api/chat/send-global', async (req, res) => {
    try { const { senderUid, senderName, avatar, message } = req.body; await db.collection("Global_Chat").add({ senderUid, senderName, avatar, message, timestamp: FieldValue.serverTimestamp(), deletedFor: [], status: 'sent' }); res.json({ success: true }); } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/chat/send-private', async (req, res) => {
    try {
        const { senderUid, receiverUid, senderName, avatar, message } = req.body;
        const chatId = senderUid < receiverUid ? `${senderUid}_${receiverUid}` : `${receiverUid}_${senderUid}`;
        const batch = db.batch();
        const msgRef = db.collection("Private_Chats").doc(chatId).collection("Messages").doc();
        batch.set(msgRef, { senderUid, senderName, avatar, message, timestamp: FieldValue.serverTimestamp(), deletedFor: [], status: 'sent' });
        batch.set(db.collection("Users").doc(senderUid).collection("Friends").doc(receiverUid), { lastMsg: "You: " + message, lastMsgTime: FieldValue.serverTimestamp() }, { merge: true });
        batch.set(db.collection("Users").doc(receiverUid).collection("Friends").doc(senderUid), { unreadCount: FieldValue.increment(1), lastMsg: message, lastMsgTime: FieldValue.serverTimestamp() }, { merge: true });
        await batch.commit(); res.json({ success: true });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/chat/delete-message', async (req, res) => {
    try {
        const { uid, receiverUid, msgIds, mode, deleteType } = req.body;
        let colRef = mode === 'global' ? db.collection("Global_Chat") : db.collection("Private_Chats").doc(uid < receiverUid ? `${uid}_${receiverUid}` : `${receiverUid}_${uid}`).collection("Messages");
        const batch = db.batch();
        msgIds.forEach(msgId => { const docRef = colRef.doc(msgId); if (deleteType === 'me') batch.update(docRef, { deletedFor: FieldValue.arrayUnion(uid) }); else if (deleteType === 'everyone') batch.delete(docRef); });
        await batch.commit(); res.json({ success: true });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.get('/api/chat/friends', async (req, res) => {
    try { 
        const uid = req.query.uid; 
        const cacheKey = `chat_friends_${uid}`;
        const cachedData = await getCache(cacheKey);
        if (cachedData) return res.json({ success: true, source: 'redis', data: cachedData });

        const snap = await db.collection("Users").doc(uid).collection("Friends").get(); 
        let friends = []; 
        snap.forEach(d => friends.push(d.data())); 
        
        await setCache(cacheKey, friends, 3); 
        res.json({ success: true, source: 'db', data: friends }); 
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
});

app.get('/api/chat/requests', async (req, res) => {
    try { 
        const uid = req.query.uid; 
        const cacheKey = `chat_req_${uid}`;
        const cachedData = await getCache(cacheKey);
        if (cachedData) return res.json({ success: true, source: 'redis', count: cachedData.length, data: cachedData });

        const snap = await db.collection("Friend_Requests").where("receiverUid", "==", uid).get(); 
        let requests = []; 
        snap.forEach(d => requests.push({ id: d.id, ...d.data() })); 
        
        await setCache(cacheKey, requests, 3); 
        res.json({ success: true, source: 'db', count: requests.length, data: requests }); 
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
});

app.get('/api/chat/messages', async (req, res) => {
    try {
        const { mode, target, uid } = req.query; 
        const cacheKey = mode === 'global' ? `chat_msgs_global` : `chat_msgs_private_${uid < target ? `${uid}_${target}` : `${target}_${uid}`}`;
        
        const cachedData = await getCache(cacheKey);
        if (cachedData) return res.json({ success: true, source: 'redis', data: cachedData });

        let msgs = [];
        if(mode === 'global') { 
            const snap = await db.collection("Global_Chat").orderBy("timestamp", "asc").limitToLast(50).get(); 
            snap.forEach(d => msgs.push({ id: d.id, ...d.data() })); 
        } else if (mode === 'private' && target && uid) { 
            const chatId = uid < target ? `${uid}_${target}` : `${target}_${uid}`; 
            const snap = await db.collection("Private_Chats").doc(chatId).collection("Messages").orderBy("timestamp", "asc").limitToLast(50).get(); 
            snap.forEach(d => msgs.push({ id: d.id, ...d.data() })); 
        }
        
        await setCache(cacheKey, msgs, 2); 
        res.json({ success: true, source: 'db', data: msgs });
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
});

app.post('/api/friends/send-request', async (req, res) => {
    try { const { senderUid, senderName, senderAvatar, receiverUid } = req.body; const reqId = `${senderUid}_${receiverUid}`; await db.collection("Friend_Requests").doc(reqId).set({ senderUid, senderName, senderAvatar, receiverUid, timestamp: FieldValue.serverTimestamp() }); res.json({ success: true }); } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/friends/accept-request', async (req, res) => {
    try {
        const { reqId, myUid, myName, myAvatar, senderUid, senderName, senderAvatar } = req.body; const batch = db.batch();
        batch.set(db.collection("Users").doc(myUid).collection("Friends").doc(senderUid), { uid: senderUid, name: senderName, avatar: senderAvatar, addedAt: FieldValue.serverTimestamp(), unreadCount: 0, lastMsg: 'Say Hello! 👋', lastMsgTime: FieldValue.serverTimestamp() });
        batch.set(db.collection("Users").doc(senderUid).collection("Friends").doc(myUid), { uid: myUid, name: myName, avatar: myAvatar, addedAt: FieldValue.serverTimestamp(), unreadCount: 0, lastMsg: 'Say Hello! 👋', lastMsgTime: FieldValue.serverTimestamp() });
        batch.delete(db.collection("Friend_Requests").doc(reqId)); await batch.commit(); res.json({ success: true });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/friends/reject-request', async (req, res) => {
    try { await db.collection("Friend_Requests").doc(req.body.reqId).delete(); res.json({ success: true }); } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/friends/unfriend', async (req, res) => {
    try {
        const { myUid, targetUid } = req.body; const batch = db.batch();
        batch.delete(db.collection("Users").doc(myUid).collection("Friends").doc(targetUid)); batch.delete(db.collection("Users").doc(targetUid).collection("Friends").doc(myUid));
        batch.delete(db.collection("Friend_Requests").doc(`${myUid}_${targetUid}`)); batch.delete(db.collection("Friend_Requests").doc(`${targetUid}_${myUid}`));
        await batch.commit(); res.json({ success: true });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

// ============================================================================
// 📸 MODULE 8.5: USER AVATAR ENGINE
// ============================================================================
app.post('/api/user/upload-avatar', async (req, res) => {
    try {
        const { uid, avatar } = req.body;
        if (!uid || !avatar) throw new Error("Missing data");
        await db.collection("Users").doc(uid).update({ Avatar: avatar });
        await setCache(`avatar_${uid}`, avatar, 86400); 
        res.json({ success: true });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/user/remove-avatar', async (req, res) => {
    try {
        const { uid } = req.body;
        await db.collection("Users").doc(uid).update({ Avatar: "" });
        await setCache(`avatar_${uid}`, "", 86400); 
        res.json({ success: true });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

// ============================================================================
// 👁️ MODULE 9: USER PRESENCE & RANK AUTOMATION
// ============================================================================
app.post('/api/user/presence', async (req, res) => {
    try { await db.collection("Users").doc(req.body.uid).update({ lastActive: FieldValue.serverTimestamp() }); res.json({ success: true }); } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/user/typing', async (req, res) => {
    try { await db.collection("Users").doc(req.body.uid).update({ typingTo: req.body.targetUid }); res.json({ success: true }); } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/notifications/clear-all', async (req, res) => {
    try { const snap = await db.collection("Users").doc(req.body.uid).collection("Notifications").get(); const batch = db.batch(); snap.forEach(doc => batch.delete(doc.ref)); await batch.commit(); res.json({ success: true }); } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/automation/verify-rank', async (req, res) => {
    try {
        const { uid } = req.body;
        let finalRank = 0;
        await db.runTransaction(async (t) => {
            const uRef = db.collection("Users").doc(uid);
            const wRef = db.collection("Wallets").doc(uid);
            const uSnap = await t.get(uRef);
            const wSnap = await t.get(wRef);
            
            if (!uSnap.exists || !wSnap.exists) return;
            
            let uData = uSnap.data();
            finalRank = parseInt(uData.Rank || 0);
            
            let rankCalc = calculateRankUpdates(uData, wSnap.data());
            if (rankCalc.Rank !== undefined) { t.update(uRef, { Rank: rankCalc.Rank }); finalRank = rankCalc.Rank; }
            if (rankCalc.Points !== undefined) { t.update(wRef, { Points: rankCalc.Points }); }
        });
        res.json({ success: true, rank: finalRank }); 
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// ============================================================================
// ⚡ MODULE 9.5: WEBSOCKET CHAT ENGINE (Real-Time Push)
// ============================================================================
io.on("connection", (socket) => {
    console.log("🟢 New Client Connected:", socket.id);

    // ১. ইউজার অনলাইনে এলে তার নিজস্ব প্রাইভেট রুমে জয়েন করবে
    socket.on("join_my_room", (uid) => {
        if (uid) {
            socket.join(uid);
            console.log(`User ${uid} joined their private room.`);
        }
    });

    // ২. রিয়েল-টাইম প্রাইভেট মেসেজ হ্যান্ডলার
    socket.on("send_private_message", async (data) => {
        try {
            const { senderUid, receiverUid, senderName, avatar, message } = data;
            const chatId = senderUid < receiverUid ? `${senderUid}_${receiverUid}` : `${receiverUid}_${senderUid}`;
            
            // ফায়ারবেসে মেসেজ সেভ করা (আপনার অরিজিনাল লজিক)
            const batch = db.batch();
            const msgRef = db.collection("Private_Chats").doc(chatId).collection("Messages").doc();
            
            batch.set(msgRef, { senderUid, senderName, avatar, message, timestamp: FieldValue.serverTimestamp(), deletedFor: [], status: 'sent' });
            batch.set(db.collection("Users").doc(senderUid).collection("Friends").doc(receiverUid), { lastMsg: "You: " + message, lastMsgTime: FieldValue.serverTimestamp() }, { merge: true });
            batch.set(db.collection("Users").doc(receiverUid).collection("Friends").doc(senderUid), { unreadCount: FieldValue.increment(1), lastMsg: message, lastMsgTime: FieldValue.serverTimestamp() }, { merge: true });
            
            await batch.commit();

            // রিসিভার অনলাইনে থাকলে তার স্ক্রিনে লাইভ পুশ করা (ডেটাবেস রিড ছাড়াই!)
            io.to(receiverUid).emit("receive_new_message", { ...data, id: msgRef.id });
            
        } catch (error) {
            console.error("Socket Message Error:", error);
        }
    });

    socket.on("disconnect", () => {
        console.log("🔴 Client Disconnected:", socket.id);
    });
});

// ============================================================================
// ⚠️ MODULE 10: GLOBAL 404 HANDLER (Fixes Network Errors)
// ============================================================================
app.use((req, res) => {
    res.status(404).json({ success: false, message: "API Route Not Found. Check your Endpoint URL." });
});

// ============================================================================
// ⚙️ MODULE 11: SERVER LISTENER
// ============================================================================
const PORT = 5000;
// 🔥 FIX: app.listen এর বদলে server.listen হবে
server.listen(PORT, '172.20.10.2', () => {
    console.log(`✅ Secure Backend Server (with WebSockets) is running at http://172.20.10.2:${PORT}`);
});