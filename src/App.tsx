import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "./supabase";
import "./styles.css";

const RECEIPTS_BUCKET = "community-receipts";
const MAX_RECEIPT_SIZE = 8 * 1024 * 1024;
const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp"];

type LedgerEntry = {
  id: string;
  entry_type: "income" | "expense";
  amount: number;
  category: string;
  note: string | null;
  entry_date: string;
  receipt_path: string | null;
  created_by: string;
  created_at: string;
  receipt_url?: string;
};

function localDateValue() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

function formatMoney(amount: number) {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium" }).format(
    new Date(`${date}T12:00:00`),
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [message, setMessage] = useState("");
  const [formMessage, setFormMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [checkingAccess, setCheckingAccess] = useState(true);
  const [canRecord, setCanRecord] = useState(false);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [entryType, setEntryType] = useState<"income" | "expense">("expense");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [entryDate, setEntryDate] = useState(localDateValue());
  const [receipt, setReceipt] = useState<File | null>(null);

  useEffect(() => {
    if (!supabase) {
      setCheckingSession(false);
      setCheckingAccess(false);
      return;
    }

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setFormMessage("");
      setCheckingSession(false);
    });

    void supabase.auth.getSession().then(({ data: sessionData, error }) => {
      if (error) setMessage("Oturum bilgisi alınamadı. Yeniden deneyin.");
      setUser(sessionData.session?.user ?? null);
      setCheckingSession(false);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!supabase || !user) {
      setCanRecord(false);
      setEntries([]);
      setCheckingAccess(false);
      return;
    }

    let cancelled = false;
    const client = supabase;

    async function loadLedger() {
      setCheckingAccess(true);
      setMessage("");

      const { data: membership, error: accessError } = await client
        .from("ledger_members")
        .select("can_record")
        .eq("user_id", user.id)
        .maybeSingle();

      if (cancelled) return;
      if (accessError) {
        setCanRecord(false);
        setMessage("Hesap yetkisi kontrol edilemedi. Daha sonra tekrar deneyin.");
        setCheckingAccess(false);
        return;
      }
      if (!membership?.can_record) {
        setCanRecord(false);
        setEntries([]);
        setCheckingAccess(false);
        return;
      }

      setCanRecord(true);
      const { data, error } = await client
        .from("ledger_entries")
        .select("id,entry_type,amount,category,note,entry_date,receipt_path,created_by,created_at")
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false });

      if (cancelled) return;
      if (error) {
        setMessage("Kayıtlar alınamadı. Bağlantınızı kontrol edip yeniden deneyin.");
        setCheckingAccess(false);
        return;
      }

      const withReceipts = await Promise.all(
        (data ?? []).map(async (entry) => {
          if (!entry.receipt_path) return entry as LedgerEntry;
          const { data: signed, error: signedError } = await client.storage
            .from(RECEIPTS_BUCKET)
            .createSignedUrl(entry.receipt_path, 60 * 60);
          return {
            ...(entry as LedgerEntry),
            receipt_url: signedError ? undefined : signed?.signedUrl,
          };
        }),
      );

      if (cancelled) return;
      setEntries(withReceipts);
      setCheckingAccess(false);
    }

    void loadLedger();
    return () => {
      cancelled = true;
    };
  }, [user, refreshKey]);

  const totals = useMemo(() => {
    const income = entries
      .filter((entry) => entry.entry_type === "income")
      .reduce((sum, entry) => sum + Number(entry.amount), 0);
    const expense = entries
      .filter((entry) => entry.entry_type === "expense")
      .reduce((sum, entry) => sum + Number(entry.amount), 0);
    return { income, expense, balance: income - expense };
  }, [entries]);

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;

    setBusy(true);
    setMessage("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setMessage("Giriş yapılamadı. E-posta ve şifrenizi kontrol edin.");
    setBusy(false);
  }

  async function handleSignUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    if (password.length < 8) {
      setMessage("Şifreniz en az 8 karakter olmalı.");
      return;
    }
    if (password !== confirmPassword) {
      setMessage("Şifreler eşleşmiyor.");
      return;
    }

    setBusy(true);
    setMessage("");
    const emailRedirectTo = new URL(import.meta.env.BASE_URL, window.location.origin).toString();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo },
    });
    if (error) {
      setMessage("Hesap oluşturulamadı. E-posta ve şifre bilgilerinizi kontrol edip yeniden deneyin.");
    } else if (data.session) {
      setMessage("Hesabınız oluşturuldu. Kasa kayıtlarına erişim için yönetici onayı gerekiyor.");
    } else {
      setMessage("Kayıt bağlantısı e-posta adresinize gönderildi. E-postanızı doğruladıktan sonra giriş yapabilirsiniz.");
    }
    setBusy(false);
  }

  async function handleSignOut() {
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.auth.signOut();
    setMessage(error ? "Oturum kapatılamadı. Yeniden deneyin." : "");
    setBusy(false);
  }

  async function handleCreateEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !user || !canRecord) return;

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setFormMessage("Tutar sıfırdan büyük olmalı.");
      return;
    }
    if (!category.trim()) {
      setFormMessage("Bir kategori yazın.");
      return;
    }
    if (receipt && !RECEIPT_TYPES.includes(receipt.type)) {
      setFormMessage("Fiş için JPG, PNG veya WebP görseli seçin.");
      return;
    }
    if (receipt && receipt.size > MAX_RECEIPT_SIZE) {
      setFormMessage("Fiş görseli en fazla 8 MB olabilir.");
      return;
    }

    setBusy(true);
    setFormMessage("");
    let receiptPath: string | null = null;

    if (receipt) {
      const extension = receipt.type === "image/jpeg" ? "jpg" : receipt.type.split("/")[1];
      receiptPath = `${user.id}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage
        .from(RECEIPTS_BUCKET)
        .upload(receiptPath, receipt, { contentType: receipt.type, upsert: false });

      if (uploadError) {
        setFormMessage("Fiş yüklenemedi. Dosyanın türünü ve boyutunu kontrol edin.");
        setBusy(false);
        return;
      }
    }

    const { error } = await supabase.from("ledger_entries").insert({
      entry_type: entryType,
      amount: numericAmount,
      category: category.trim(),
      note: note.trim() || null,
      entry_date: entryDate,
      receipt_path: receiptPath,
      created_by: user.id,
    });

    if (error) {
      setFormMessage("Kayıt eklenemedi. Hesap yetkinizi kontrol edin ve yeniden deneyin.");
      setBusy(false);
      return;
    }

    setAmount("");
    setCategory("");
    setNote("");
    setEntryDate(localDateValue());
    setReceipt(null);
    const fileInput = document.getElementById("receipt") as HTMLInputElement | null;
    if (fileInput) fileInput.value = "";
    setFormMessage("Kayıt eklendi.");
    setRefreshKey((value) => value + 1);
    setBusy(false);
  }

  return (
    <main className="page-shell">
      {!user ? (
        <section className="auth-card" aria-labelledby="page-title">
          <div className="mark" aria-hidden="true">₺</div>
          <p className="eyebrow">TOPLULUK YÖNETİMİ</p>
          <h1 id="page-title">Topluluk Bütçesi</h1>
          <p className="intro">{authMode === "signin" ? "Gelir ve gider kayıtlarına ulaşmak için hesabınızla giriş yapın." : "Yeni bir hesap oluşturun. Kasa kayıtlarına erişim yönetici onayı gerektirir."}</p>

          {!isSupabaseConfigured ? (
            <div className="notice" role="status">
              Supabase bağlantısı ayarlanmamış. Uygulama yapılandırmasını kontrol edin.
            </div>
          ) : checkingSession ? (
            <p className="status" role="status">Oturum kontrol ediliyor…</p>
          ) : (
            <form className="login-form" onSubmit={authMode === "signin" ? handleSignIn : handleSignUp}>
              <label htmlFor="email">E-posta adresi</label>
              <input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="ornek@topluluk.org" required />
              <label htmlFor="password">Şifre</label>
              <input id="password" type="password" autoComplete={authMode === "signin" ? "current-password" : "new-password"} minLength={authMode === "signup" ? 8 : undefined} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={authMode === "signup" ? "En az 8 karakter" : "Şifreniz"} required />
              {authMode === "signup" && <>
                <label htmlFor="confirm-password">Şifreyi tekrar girin</label>
                <input id="confirm-password" type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Şifrenizi tekrar yazın" required />
              </>}
              <button className="button" type="submit" disabled={busy}>{busy ? (authMode === "signin" ? "Giriş yapılıyor…" : "Hesap oluşturuluyor…") : (authMode === "signin" ? "Giriş yap" : "Kayıt ol")}</button>
            </form>
          )}
          {message && <p className="message" role="alert">{message}</p>}
          {isSupabaseConfigured && !checkingSession && <p className="auth-switch">{authMode === "signin" ? "Henüz hesabınız yok mu?" : "Zaten hesabınız var mı?"}<button className="text-button" type="button" onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setMessage(""); setPassword(""); setConfirmPassword(""); }}>{authMode === "signin" ? "Kayıt ol" : "Giriş yap"}</button></p>}
          <p className="footer-note">Yeni hesaplar oluşturulabilir; topluluk kasa kayıtlarına erişim için yöneticinin ayrıca yetki vermesi gerekir.</p>
        </section>
      ) : (
        <div className="ledger-layout">
          <header className="topbar">
            <div className="brand-lockup">
              <div className="mark small" aria-hidden="true">₺</div>
              <div><p className="eyebrow">TOPLULUK YÖNETİMİ</p><h1>Topluluk Bütçesi</h1></div>
            </div>
            <div className="account-menu"><span title={user.email ?? undefined}>{user.email}</span><button className="text-button" onClick={handleSignOut} disabled={busy}>Çıkış</button></div>
          </header>

          {checkingAccess ? (
            <section className="status-panel" role="status">Hesap yetkisi ve kayıtlar kontrol ediliyor…</section>
          ) : !canRecord ? (
            <section className="access-panel">
              <div className="access-icon" aria-hidden="true">⌑</div>
              <h2>Hesabınız henüz yetkilendirilmedi</h2>
              <p>Bu hesabın gelir-gider kayıtlarına erişebilmesi için yöneticinin yetki vermesi gerekiyor.</p>
              <button className="button secondary" onClick={handleSignOut} disabled={busy}>Oturumu kapat</button>
            </section>
          ) : (
            <>
              <section className="welcome-row">
                <div><p className="eyebrow">ORTAK KASA</p><h2>Hesap hareketleri</h2><p className="muted">Gelirleri ve giderleri tek yerden takip edin.</p></div>
                <div className="entry-count">{entries.length}<span> kayıt</span></div>
              </section>

              <section className="summary-grid" aria-label="Bakiye özeti">
                <article className="summary-card balance-card"><span>Güncel bakiye</span><strong>{formatMoney(totals.balance)}</strong><small>Toplam gelir − toplam gider</small></article>
                <article className="summary-card"><span>Toplam gelir</span><strong className="income-text">{formatMoney(totals.income)}</strong><small>Kaydedilen tüm gelirler</small></article>
                <article className="summary-card"><span>Toplam gider</span><strong className="expense-text">{formatMoney(totals.expense)}</strong><small>Kaydedilen tüm giderler</small></article>
              </section>

              <div className="content-grid">
                <section className="panel form-panel" aria-labelledby="new-entry-title">
                  <div className="panel-heading"><div><p className="eyebrow">YENİ HAREKET</p><h2 id="new-entry-title">Kayıt ekle</h2></div><div className="plus-mark" aria-hidden="true">＋</div></div>
                  <form className="entry-form" onSubmit={handleCreateEntry}>
                    <fieldset className="type-switch">
                      <legend>Kayıt türü</legend>
                      <button type="button" aria-pressed={entryType === "income"} className={entryType === "income" ? "type-choice selected income-choice" : "type-choice"} onClick={() => setEntryType("income")}>Gelir</button>
                      <button type="button" aria-pressed={entryType === "expense"} className={entryType === "expense" ? "type-choice selected expense-choice" : "type-choice"} onClick={() => setEntryType("expense")}>Gider</button>
                    </fieldset>
                    <label htmlFor="amount">Tutar <span>₺</span></label>
                    <div className="amount-field"><input id="amount" type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0,00" required /><span>TRY</span></div>
                    <label htmlFor="category">Kategori</label>
                    <input id="category" value={category} onChange={(event) => setCategory(event.target.value)} maxLength={80} placeholder={entryType === "income" ? "Örn. bağış, aidat" : "Örn. ulaşım, malzeme"} required />
                    <label htmlFor="entry-date">Tarih</label>
                    <input id="entry-date" type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} required />
                    <label htmlFor="note">Açıklama <span>İsteğe bağlı</span></label>
                    <textarea id="note" rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Bu hareketle ilgili kısa bir not…" />
                    <label htmlFor="receipt">Fiş görseli <span>İsteğe bağlı</span></label>
                    <label className="file-drop" htmlFor="receipt">
                      <span className="file-icon" aria-hidden="true">↑</span>
                      <span><strong>{receipt ? receipt.name : "Görsel seçin"}</strong><small>JPG, PNG veya WebP · en fazla 8 MB</small></span>
                      <input id="receipt" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setReceipt(event.currentTarget.files?.[0] ?? null)} />
                    </label>
                    {formMessage && <p className={formMessage === "Kayıt eklendi." ? "message success-message" : "message"} role="status">{formMessage}</p>}
                    <button className="button submit-button" type="submit" disabled={busy}>{busy ? "Kaydediliyor…" : "Kaydı ekle"}</button>
                  </form>
                </section>

                <section className="panel history-panel" aria-labelledby="history-title">
                  <div className="panel-heading history-heading"><div><p className="eyebrow">ORTAK KASA</p><h2 id="history-title">Son hareketler</h2></div><span className="secure-label"><span /> Özel kayıtlar</span></div>
                  {message && <p className="message history-message" role="status">{message}</p>}
                  {entries.length === 0 ? (
                    <div className="empty-state"><div className="empty-icon" aria-hidden="true">↗</div><h3>Henüz kayıt yok</h3><p>İlk gelir veya gider hareketini eklediğinizde burada görünecek.</p></div>
                  ) : (
                    <div className="entry-list">
                      {entries.map((entry) => (
                        <article className="entry-row" key={entry.id}>
                          <div className={entry.entry_type === "income" ? "entry-symbol income-symbol" : "entry-symbol expense-symbol"} aria-hidden="true">{entry.entry_type === "income" ? "↙" : "↗"}</div>
                          <div className="entry-main"><strong>{entry.category}</strong><span>{formatDate(entry.entry_date)}{entry.note ? ` · ${entry.note}` : ""}</span>{entry.receipt_path && (entry.receipt_url ? <a className="receipt-link" href={entry.receipt_url} target="_blank" rel="noreferrer">Fiş görselini aç ↗</a> : <small className="receipt-unavailable">Fiş görseli şu anda açılamıyor</small>)}</div>
                          <strong className={entry.entry_type === "income" ? "entry-amount income-text" : "entry-amount expense-text"}>{entry.entry_type === "income" ? "+" : "−"}{formatMoney(Number(entry.amount))}</strong>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </div>
              <p className="privacy-note"><span aria-hidden="true">◈</span> Kasa kayıtları ve fiş görselleri yalnızca yetkilendirilmiş hesaplara açıktır.</p>
            </>
          )}
        </div>
      )}
    </main>
  );
}
