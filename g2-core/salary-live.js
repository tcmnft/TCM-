(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    let owner = null, revision = -1, generation = 0, task = null, flight = false;
    let budget = null, record = null, message = '', cooldownUntil = 0;
    let burstTimer = null, expiryTimer = null, wakeTimer = null;
    const MAX_REQUESTS = 12, MAX_BURST_MS = 20000;

    function context() {
        const uid = window.RAM_STATE?.user?.UID, session = window.dashboardSession;
        const localUid = localStorage.getItem('uid'), token = localStorage.getItem('token');
        return typeof uid === 'string' && uid === localUid && token && session &&
            !session.closed && !session.blocked ? { uid, epoch: session.epoch, token } : null;
    }
    function same(a, b) {
        return !!a && !!b && a.uid === b.uid && a.epoch === b.epoch && a.token === b.token;
    }
    function visible() {
        const view = byId('view-rewards');
        return !document.hidden && !!view && getComputedStyle(view).display !== 'none' &&
            getComputedStyle(view).visibility !== 'hidden';
    }
    function elapsed(x) {
        return Math.max(0, performance.now() - x.perf, Date.now() - x.wall);
    }
    function cancelTask() {
        generation++;
        if (task) clearTimeout(task.timer);
        task = null;
        clearTimeout(burstTimer);
        burstTimer = null;
    }
    function clear() {
        cancelTask();
        clearTimeout(expiryTimer);
        clearTimeout(wakeTimer);
        expiryTimer = wakeTimer = null;
        owner = null;
        record = null;
        budget = null;
        revision = -1;
        message = '';
        cooldownUntil = 0;
        window.G2SalaryClaim?.clear();
        draw();
    }
    function text(id, value) {
        const node = byId(id);
        if (node) node.textContent = value;
    }
    function readControls(reason) {
        let box = byId('salaryMembershipReadControls');
        if (!box) {
            box = document.createElement('div');
            box.id = 'salaryMembershipReadControls';
            box.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin:12px 0;';
            for (const [id, label] of [
                ['salaryMembershipResume', 'Resume verification'],
                ['salaryMembershipRestart', 'Restart verification']
            ]) {
                const button = document.createElement('button');
                button.id = id;
                button.type = 'button';
                button.className = 'act-btn';
                button.textContent = label;
                button.style.cssText = 'width:auto;min-height:44px;white-space:normal;flex:1 1 160px;';
                box.append(button);
            }
            reason.after(box);
        }
        return box;
    }
    function draw() {
        if (owner && !same(owner, context())) {
            cancelTask();
            clearTimeout(expiryTimer);
            clearTimeout(wakeTimer);
            owner = null;
            record = null;
            budget = null;
            revision = -1;
            cooldownUntil = 0;
            window.G2SalaryClaim?.clear();
            message = 'Account changed; verification required.';
        }
        const level = byId('userSalaryLevel');
        if (!level) return;
        let reason = byId('salaryEligibilityReason');
        if (!reason) {
            reason = document.createElement('p');
            reason.id = 'salaryEligibilityReason';
            reason.setAttribute('role', 'status');
            reason.setAttribute('aria-live', 'polite');
            reason.style.cssText = 'font-size:.75rem;color:var(--text-sub);overflow-wrap:anywhere;line-height:1.7;';
            level.parentElement.parentElement.after(reason);
        }
        const data = record?.data, display = data?.membershipDisplay;
        const live = !!record && display.expiresAt !== null && elapsed(record) < record.ttl;
        const kind = display && display.expiresAt !== null && !live
            ? 'stale' : display?.kind || 'incomplete';
        const names = {
            complete: 'Membership verified · payment disabled',
            partial: 'Partial verified subtotal',
            'review-required': 'Review required · partial subtotal',
            paused: 'Paused · partial subtotal only',
            stale: 'Stale · verification expired',
            incomplete: 'Verification incomplete'
        };
        text('salaryStatusBadge', cooldownUntil > Date.now() ? 'Paused · cooldown' : names[kind]);
        text('userSalaryLevel', data?.salary?.level
            ? data.salary.level + (data.salary.capDisplay ? ' · cap ' + data.salary.capDisplay : '')
            : 'Unavailable');
        text('userSalaryAmount', 'Unavailable');

        for (const [prefix, key] of [['aHand', 'a'], ['bcHand', 'bc']]) {
            const count = display?.verifiedQualifyingSubtotals?.[key];
            const target = data?.salary?.targets?.[key];
            const countValid = Number.isSafeInteger(count) && count >= 0;
            const targetValid = Number.isSafeInteger(target) && target > 0;
            const valid = countValid && targetValid;
            const label = countValid
                ? count + (targetValid ? ' / ' + target : ' · target unavailable') +
                    (display.countsAreComplete ? '' : ' · partial')
                : kind === 'stale' ? 'Unavailable · expired' : 'Unavailable';
            text(prefix + 'Count', label);
            const bar = byId(prefix + 'Bar');
            if (bar) {
                bar.style.width = (valid ? Math.min(100, count / target * 100) : 0) + '%';
                bar.parentElement.setAttribute('role', 'progressbar');
                bar.parentElement.setAttribute('aria-label',
                    key === 'a' ? 'A-Hand membership' : 'B+C membership');
                bar.parentElement.setAttribute('aria-valuetext', label);
            }
        }

        let detail = 'Membership progress does not authorize salary payment.';
        if (display) {
            detail += ' Unresolved members: ' + display.unresolvedMembers +
                '; remaining known members: ' + display.remainingKnownMembers +
                '; expired assessments: ' + display.expiredVerifiedMembers + '.';
            if (!display.rosterEnumerationComplete) detail += ' Roster enumeration is unfinished.';
            if (live && display.oldestFreshMemberObservationAt !== null) {
                const age = Math.max(0, Math.ceil((display.serverNowMs -
                    display.oldestFreshMemberObservationAt + elapsed(record)) / 1000));
                detail += ' Oldest displayed member observation: approximately ' +
                    age + ' seconds at this update.';
            }
            if (kind === 'stale') detail += ' Previously displayed evidence has expired.';
            if (data.coverage.explicitRestartRequired) {
                detail += ' Review/pause requires an explicit restart after the cause is addressed.';
            }
        }
        reason.textContent = (message ? message + ' ' : '') + detail;

        const button = byId('salaryClaimButton');
        if (button) {
            button.disabled = true;
        }
        const receipt = byId('salaryReceiptButton');
        if (receipt) {
            receipt.disabled = true;
            receipt.onclick = null;
        }

        const box = readControls(reason);
        const resume = box.querySelector('#salaryMembershipResume');
        const restart = box.querySelector('#salaryMembershipRestart');
        const restartNeeded = data?.coverage?.explicitRestartRequired === true;
        resume.hidden = !!task || (kind === 'complete' && live && !message);
        restart.hidden = !restartNeeded;
        resume.disabled = !owner || !visible() || flight || Date.now() < cooldownUntil;
        restart.disabled = resume.disabled;
        resume.onclick = () => start(true, false);
        restart.onclick = () => start(true, true);
    }
    function armExpiry() {
        clearTimeout(expiryTimer);
        expiryTimer = null;
        if (!record || !visible() ||
            record.data.membershipDisplay.expiresAt === null) return;
        const shown = record, remaining = shown.ttl - elapsed(shown);
        if (remaining <= 0) {
            draw();
            return;
        }
        expiryTimer = setTimeout(() => {
            if (record === shown && same(owner, context()) && visible()) draw();
        }, Math.ceil(remaining) + 1);
    }
    function pause(reason, seconds = 0) {
        cancelTask();
        message = reason;
        if (seconds > 0) {
            cooldownUntil = Math.max(cooldownUntil, Date.now() + seconds * 1000);
        }
        clearTimeout(wakeTimer);
        wakeTimer = null;
        draw();
        if (cooldownUntil > Date.now()) {
            wakeTimer = setTimeout(() => {
                if (same(owner, context()) && visible()) draw();
            }, cooldownUntil - Date.now() + 1);
        }
    }
    function validTask(t) {
        return task === t && t.generation === generation &&
            same(t.context, context()) && visible() &&
            !budget.stopped && elapsed(budget) < MAX_BURST_MS;
    }
    function checked(data, t) {
        const m = data?.membershipDisplay, c = data?.coverage;
        if (!data || data.uid !== t.context.uid || data.period !== t.period ||
            data.schemaVersion !== 1 ||
            data.sourceContractVersion !== 'salary-membership-v3' ||
            !Number.isSafeInteger(data.revision) || data.revision < revision ||
            data.receipt !== null || !m || m.contractVersion !== 1 || !c ||
            !['complete', 'partial', 'review-required', 'paused', 'stale', 'incomplete'].includes(m.kind) ||
            typeof m.countsAreComplete !== 'boolean' ||
            m.countsAreComplete !== c.complete ||
            typeof c.continuation !== 'boolean' ||
            typeof c.explicitRestartRequired !== 'boolean' ||
            !Number.isSafeInteger(m.serverNowMs) ||
            !(m.expiresAt === null || Number.isSafeInteger(m.expiresAt) &&
                m.expiresAt - m.serverNowMs <= 60000) ||
            !['unresolvedMembers', 'remainingKnownMembers', 'expiredVerifiedMembers'].every(
                key => Number.isSafeInteger(m[key]) && m[key] >= 0) ||
            !['a', 'bc'].every(key =>
                m.verifiedQualifyingSubtotals?.[key] === null ||
                Number.isSafeInteger(m.verifiedQualifyingSubtotals?.[key]) &&
                m.verifiedQualifyingSubtotals[key] >= 0)) return false;
        return true;
    }
    async function pump(t) {
        if (!validTask(t)) return;
        if (flight) {
            t.waiting = true;
            return;
        }
        if (budget.requests >= MAX_REQUESTS) {
            budget.stopped = true;
            pause('Burst limit reached. Use Resume to continue.');
            return;
        }
        flight = true;
        t.waiting = false;
        budget.requests++;
        const sent = performance.now();
        draw();
        try {
            const restart = t.restart;
            t.restart = false;
            const result = await window.dashboardRequest(
                '/phase3/salary/read?period=' + encodeURIComponent(t.period) +
                (restart ? '&restart=1' : ''), 'GET'
            );
            if (!validTask(t)) return;
            const status = Number(result?.status);
            if (status === 429 || status === 503) {
                const own = result?.uid === t.context.uid &&
                    result?.period === t.period &&
                    result?.sourceContractVersion === 'salary-membership-v3';
                const seconds = own && Number.isSafeInteger(result.retryAfterSeconds) &&
                    result.retryAfterSeconds > 0 && result.retryAfterSeconds <= 300
                    ? result.retryAfterSeconds : status === 429 ? 60 : 30;
                pause('Server paused verification. Resume after the cooldown.', seconds);
                return;
            }
            if (status !== 200 || result?.success !== true) {
                if (status === 401 || status === 403 || status === 409) {
                    clear();
                    message = 'Session/account verification required.';
                    draw();
                } else {
                    pause('Read failed. Resume verification when the connection is available.', 15);
                }
                return;
            }
            if (!checked(result, t)) {
                pause('Membership response requires review.');
                return;
            }
            revision = result.revision;
            const m = result.membershipDisplay;
            record = {
                data: result,
                perf: performance.now(),
                wall: Date.now(),
                ttl: m.expiresAt === null ? 0 :
                    Math.max(0, m.expiresAt - m.serverNowMs -
                        (performance.now() - sent))
            };
            message = '';
            draw();
            armExpiry();
            if (result.coverage.explicitRestartRequired) {
                pause('Verification paused or has unresolved evidence. Restart is explicit.');
                return;
            }
            if (!result.coverage.continuation) {
                cancelTask();
                draw();
                return;
            }
            const retry = result.coverage.retryAfterSeconds;
            const seconds = Number.isSafeInteger(retry) && retry > 0 && retry <= 300
                ? retry : 1;
            if (budget.requests >= MAX_REQUESTS ||
                elapsed(budget) + seconds * 1000 >= MAX_BURST_MS) {
                budget.stopped = true;
                pause('Burst limit reached. Use Resume to continue.');
                return;
            }
            t.timer = setTimeout(() => { void pump(t); }, seconds * 1000);
        } catch {
            if (validTask(t)) pause('Connection unavailable. Resume verification later.', 15);
        } finally {
            flight = false;
            const queued = task;
            if (queued?.waiting && validTask(queued)) void pump(queued);
            else if (same(owner, context()) && visible()) draw();
        }
    }
    function start(manual = false, restart = false) {
        const current = context();
        if (!current) {
            clear();
            return;
        }
        if (!same(owner, current)) {
            clear();
            owner = current;
        }
        cancelTask();
        if (!visible()) {
            clearTimeout(expiryTimer);
            draw();
            return;
        }
        if (Date.now() < cooldownUntil) {
            pause('Cooldown active; no request was sent.');
            return;
        }
        if (restart &&
            (!manual || record?.data.coverage.explicitRestartRequired !== true)) {
            message = 'An explicit server restart signal is required.';
            draw();
            return;
        }
        if (!budget || manual) {
            budget = {
                perf: performance.now(),
                wall: Date.now(),
                requests: 0,
                stopped: false
            };
        }
        if (budget.stopped || budget.requests >= MAX_REQUESTS ||
            elapsed(budget) >= MAX_BURST_MS) {
            budget.stopped = true;
            message = 'Burst limit reached. Use Resume to continue.';
            draw();
            armExpiry();
            return;
        }
        const parts = new Intl.DateTimeFormat('en', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit'
        }).formatToParts(new Date());
        const period = parts.find(x => x.type === 'year').value + '-' +
            parts.find(x => x.type === 'month').value;
        task = {
            context: owner,
            generation,
            period,
            restart,
            waiting: false,
            timer: null
        };
        message = 'Reading authoritative membership evidence.';
        draw();
        armExpiry();
        burstTimer = setTimeout(() => {
            if (task) {
                budget.stopped = true;
                pause('Burst time limit reached. Use Resume to continue.');
            }
        }, Math.max(1, MAX_BURST_MS - elapsed(budget)));
        void pump(task);
    }
    function visibility() {
        if (!visible()) {
            cancelTask();
            clearTimeout(expiryTimer);
            clearTimeout(wakeTimer);
            expiryTimer = wakeTimer = null;
            return;
        }
        if (!same(owner, context())) {
            clear();
            start();
            return;
        }
        draw();
        armExpiry();
        start();
    }
    function install() {
        clear();
        const snapshot = window.applyDashboardSnapshot;
        if (typeof snapshot === 'function') {
            window.applyDashboardSnapshot = function () {
                const result = snapshot.apply(this, arguments);
                start();
                return result;
            };
        }
        const logout = window.clearDashboardSession;
        if (typeof logout === 'function') {
            window.clearDashboardSession = function () {
                clear();
                return logout.apply(this, arguments);
            };
        }
        const view = byId('view-rewards');
        if (view) {
            new MutationObserver(visibility).observe(view, {
                attributes: true,
                attributeFilter: ['class', 'style', 'hidden']
            });
        }
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('pagehide', () => {
            cancelTask();
            clearTimeout(expiryTimer);
            clearTimeout(wakeTimer);
        });
        window.addEventListener('pageshow', visibility);
        window.addEventListener('storage', e => {
            if (e.key === null || ['uid', 'token'].includes(e.key)) {
                clear();
                if (visible()) start();
            }
        });
        if (visible()) start();
    }
    window.SalaryLiveBinding = Object.freeze({
        refresh: () => start(),
        clear
    });
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', install, { once: true });
    } else {
        install();
    }
})();
