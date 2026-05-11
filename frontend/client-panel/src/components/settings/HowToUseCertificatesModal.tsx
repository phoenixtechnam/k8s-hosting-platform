import { useState, type ReactNode } from 'react';
import { X, HelpCircle, Info } from 'lucide-react';

type Platform =
  | 'windows-chrome'
  | 'windows-firefox'
  | 'macos'
  | 'linux-chrome'
  | 'linux-firefox'
  | 'ios'
  | 'android'
  | 'cli';

const TABS: ReadonlyArray<{ value: Platform; label: string }> = [
  { value: 'windows-chrome', label: 'Windows (Chrome/Edge)' },
  { value: 'windows-firefox', label: 'Windows (Firefox)' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux-chrome', label: 'Linux (Chrome)' },
  { value: 'linux-firefox', label: 'Linux (Firefox)' },
  { value: 'ios', label: 'iOS' },
  { value: 'android', label: 'Android' },
  { value: 'cli', label: 'CLI / curl' },
];

interface HowToUseCertificatesModalProps {
  readonly onClose: () => void;
}

export default function HowToUseCertificatesModal({ onClose }: HowToUseCertificatesModalProps) {
  const [tab, setTab] = useState<Platform>('windows-chrome');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="mtls-help-modal"
    >
      <div className="w-full max-w-3xl rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl max-h-[90vh] flex flex-col">
        <header className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 p-5">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <HelpCircle size={18} /> How to use your client certificate
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div className="border-b border-gray-200 dark:border-gray-700 px-5 pt-3">
          <div className="flex flex-wrap gap-1">
            {TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setTab(t.value)}
                className={`rounded-t-lg px-3 py-2 text-xs font-medium ${
                  tab === t.value
                    ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-b-2 border-blue-600'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
                data-testid={`mtls-help-tab-${t.value}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-y-auto p-5 text-sm text-gray-700 dark:text-gray-300 space-y-3">
          <Preface />
          {tab === 'windows-chrome'   && <WindowsChrome   />}
          {tab === 'windows-firefox'  && <WindowsFirefox  />}
          {tab === 'macos'            && <MacOS           />}
          {tab === 'linux-chrome'     && <LinuxChrome     />}
          {tab === 'linux-firefox'    && <LinuxFirefox    />}
          {tab === 'ios'              && <IOS             />}
          {tab === 'android'          && <Android         />}
          {tab === 'cli'              && <CLI             />}
        </div>

        <footer className="border-t border-gray-200 dark:border-gray-700 px-5 py-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─── Shared preface ───────────────────────────────────────────────────

function Preface() {
  return (
    <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-xs text-blue-900 dark:text-blue-200 flex gap-2">
      <Info size={14} className="flex-shrink-0 mt-0.5" />
      <div>
        When you issued the cert, you received <strong>three files</strong>:
        the certificate (<code className="font-mono">.pem</code>), the private key
        (<code className="font-mono">.pem</code>), and optionally a bundled
        <code className="font-mono"> .p12</code> file (cert + key + CA in one).
        For browser use, the <code className="font-mono">.p12</code> is the easiest path —
        most OSes import it natively. The private key is shown <em>only once</em>;
        if you lose it, revoke the cert and issue a fresh one.
      </div>
    </div>
  );
}

// ─── Per-platform content ─────────────────────────────────────────────

function StepList({ steps }: { steps: ReadonlyArray<ReactNode> }) {
  return (
    <ol className="list-decimal list-outside ml-5 space-y-1">
      {steps.map((s, i) => <li key={i}>{s}</li>)}
    </ol>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-xs bg-gray-100 dark:bg-gray-900 rounded px-1">{children}</code>;
}

function Tip({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs italic text-gray-500 dark:text-gray-400">
      {children}
    </p>
  );
}

function WindowsChrome() {
  return (
    <>
      <h3 className="font-semibold text-gray-900 dark:text-gray-100">Windows · Chrome &amp; Edge</h3>
      <p>Chrome and Edge on Windows both use the Windows Certificate Store, so a single import covers both browsers.</p>
      <StepList steps={[
        <>Double-click the <Mono>.p12</Mono> file you downloaded.</>,
        <><strong>Store Location:</strong> <Mono>Current User</Mono> → <em>Next</em>.</>,
        <><strong>File to Import:</strong> confirm the path → <em>Next</em>.</>,
        <><strong>Password:</strong> enter the password you set when issuing → <em>Next</em>.</>,
        <><strong>Certificate Store:</strong> leave on "Automatically select" → <em>Next</em> → <em>Finish</em>.</>,
        <>Click <em>Yes</em> if Windows asks to trust the CA root.</>,
        <>Open Chrome or Edge, navigate to your mTLS-protected URL, pick the cert from the picker.</>,
      ]} />
      <Tip>Remove later: Win+R → <Mono>certmgr.msc</Mono> → Personal → Certificates → right-click → Delete.</Tip>
      <Tip>Browsers cache the TLS handshake for ~5 min — fully close the browser if changes don't take effect.</Tip>
    </>
  );
}

function WindowsFirefox() {
  return (
    <>
      <h3 className="font-semibold text-gray-900 dark:text-gray-100">Windows · Firefox</h3>
      <p>Firefox uses its own certificate store, separate from Windows. Import into Firefox directly:</p>
      <StepList steps={[
        <>Open <Mono>about:preferences#privacy</Mono> in Firefox.</>,
        <>Scroll to <strong>Certificates</strong> → <em>View Certificates</em>.</>,
        <>Tab <strong>Your Certificates</strong> → <em>Import</em>.</>,
        <>Select your <Mono>.p12</Mono> file → enter the password.</>,
        <>Navigate to your mTLS URL → Firefox shows a "Identification request" dialog → pick your cert.</>,
      ]} />
      <Tip>Remove later: same dialog → select the cert → <em>Delete</em>.</Tip>
    </>
  );
}

function MacOS() {
  return (
    <>
      <h3 className="font-semibold text-gray-900 dark:text-gray-100">macOS · Safari, Chrome, Edge</h3>
      <p>macOS uses the Keychain for all WebKit/Chromium browsers. Firefox has its own store (see Windows Firefox above — UI is the same on Mac).</p>
      <StepList steps={[
        <>Double-click the <Mono>.p12</Mono> file.</>,
        <>Keychain Access opens — pick <strong>login</strong> keychain → <em>Add</em>.</>,
        <>Enter the password you set when issuing the cert.</>,
        <>Open the browser, navigate to your mTLS URL, pick the cert from the picker.</>,
      ]} />
      <Tip>Remove later: <Mono>Keychain Access</Mono> → search by CN → right-click → Delete.</Tip>
      <Tip>If macOS doesn't trust the CA, open Keychain Access → find the issuing CA → Get Info → Trust → "Always Trust" for SSL.</Tip>
    </>
  );
}

function LinuxChrome() {
  return (
    <>
      <h3 className="font-semibold text-gray-900 dark:text-gray-100">Linux · Chrome &amp; Chromium</h3>
      <p>Chromium-based browsers on Linux read from the system NSS database. Import with <Mono>certutil</Mono> or via the browser UI:</p>
      <p className="text-xs font-semibold mt-2">Browser UI:</p>
      <StepList steps={[
        <>Open <Mono>chrome://settings/certificates</Mono>.</>,
        <>Tab <strong>Your Certificates</strong> → <em>Import</em>.</>,
        <>Pick the <Mono>.p12</Mono> → enter the password.</>,
      ]} />
      <p className="text-xs font-semibold mt-2">Command line:</p>
      <pre className="font-mono text-[11px] bg-gray-100 dark:bg-gray-900 rounded p-2 overflow-x-auto">{`# Once-only init:
sudo apt install libnss3-tools   # (or dnf install nss-tools)
certutil -d sql:$HOME/.pki/nssdb -N --empty-password 2>/dev/null

# Import:
pk12util -d sql:$HOME/.pki/nssdb -i path/to/cert.p12`}</pre>
      <Tip>Remove later: <Mono>certutil -d sql:$HOME/.pki/nssdb -D -n &lt;nickname&gt;</Mono>.</Tip>
    </>
  );
}

function LinuxFirefox() {
  return (
    <>
      <h3 className="font-semibold text-gray-900 dark:text-gray-100">Linux · Firefox</h3>
      <p>Firefox on Linux uses its own NSS database (same UX as Windows Firefox):</p>
      <StepList steps={[
        <>Open <Mono>about:preferences#privacy</Mono>.</>,
        <>Scroll to <strong>Certificates</strong> → <em>View Certificates</em>.</>,
        <>Tab <strong>Your Certificates</strong> → <em>Import</em>.</>,
        <>Select the <Mono>.p12</Mono> → enter the password.</>,
      ]} />
    </>
  );
}

function IOS() {
  return (
    <>
      <h3 className="font-semibold text-gray-900 dark:text-gray-100">iOS · Safari</h3>
      <p>iOS installs certificates via Configuration Profiles. The <Mono>.p12</Mono> file installs the identity (cert + key); you may also need to install the CA root separately if your CA is self-signed.</p>
      <StepList steps={[
        <>Email or AirDrop the <Mono>.p12</Mono> to your iPhone/iPad — or open it from Files.</>,
        <>iOS prompts: <em>Allow Configuration Profile</em> → confirm.</>,
        <>Open <Mono>Settings</Mono> → at the top, <em>Profile Downloaded</em> → <em>Install</em> → enter your device passcode → enter the <Mono>.p12</Mono> password.</>,
        <><strong>Trust the CA (self-signed only):</strong> <Mono>Settings → General → About → Certificate Trust Settings</Mono> → enable full trust for your CA root.</>,
        <>Open Safari → navigate to your mTLS URL → iOS asks which identity to present.</>,
      ]} />
      <Tip>Remove later: <Mono>Settings → General → VPN &amp; Device Management → Configuration Profile → Remove</Mono>.</Tip>
    </>
  );
}

function Android() {
  return (
    <>
      <h3 className="font-semibold text-gray-900 dark:text-gray-100">Android · Chrome, Edge, Samsung Internet</h3>
      <p>Android keeps two cert stores: the system store (requires root or vendor blessing) and the user store (per-user, where your .p12 lives).</p>
      <StepList steps={[
        <>Copy the <Mono>.p12</Mono> file to your phone (USB transfer, Drive, etc.).</>,
        <>Open <Mono>Settings → Security &amp; privacy → More security &amp; privacy → Encryption &amp; credentials → Install a certificate → VPN &amp; app user certificate</Mono> (exact path varies by Android version).</>,
        <>Pick the <Mono>.p12</Mono> file → enter the password → give the certificate a name.</>,
        <>Open Chrome → mTLS URL → Android prompts to choose the identity.</>,
      ]} />
      <Tip>Removal: <Mono>Settings → Security → Encryption &amp; credentials → User credentials → tap the cert → Remove</Mono>.</Tip>
    </>
  );
}

function CLI() {
  return (
    <>
      <h3 className="font-semibold text-gray-900 dark:text-gray-100">curl, wget, scripts</h3>
      <p>For API calls or scripts, use the raw PEM files directly — no <Mono>.p12</Mono> needed.</p>
      <p className="text-xs font-semibold mt-2">curl:</p>
      <pre className="font-mono text-[11px] bg-gray-100 dark:bg-gray-900 rounded p-2 overflow-x-auto">{`curl --cert client.pem --key client.key https://protected.example.com/api/data`}</pre>
      <p className="text-xs font-semibold mt-2">wget:</p>
      <pre className="font-mono text-[11px] bg-gray-100 dark:bg-gray-900 rounded p-2 overflow-x-auto">{`wget --certificate=client.pem --private-key=client.key https://protected.example.com/`}</pre>
      <p className="text-xs font-semibold mt-2">openssl s_client (handshake debug):</p>
      <pre className="font-mono text-[11px] bg-gray-100 dark:bg-gray-900 rounded p-2 overflow-x-auto">{`openssl s_client -connect protected.example.com:443 \\
  -cert client.pem -key client.key -servername protected.example.com`}</pre>
      <p className="text-xs font-semibold mt-2">Node.js (https module):</p>
      <pre className="font-mono text-[11px] bg-gray-100 dark:bg-gray-900 rounded p-2 overflow-x-auto">{`import https from 'node:https';
import { readFileSync } from 'node:fs';
const opts = {
  cert: readFileSync('client.pem'),
  key:  readFileSync('client.key'),
};
https.get('https://protected.example.com/', opts, (res) => { /* ... */ });`}</pre>
      <p className="text-xs font-semibold mt-2">Python (requests):</p>
      <pre className="font-mono text-[11px] bg-gray-100 dark:bg-gray-900 rounded p-2 overflow-x-auto">{`import requests
r = requests.get('https://protected.example.com/',
                 cert=('client.pem', 'client.key'))`}</pre>
      <Tip>If your certificate's CA is private and not in the system trust store, add <Mono>--cacert ca.pem</Mono> (curl) or the equivalent.</Tip>
    </>
  );
}
