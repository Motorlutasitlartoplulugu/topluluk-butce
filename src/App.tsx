import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { CSSProperties } from "react";
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
  entered_by_name: string | null;
  updated_by_name?: string | null;
  note: string | null;
  entry_date: string;
  receipt_path: string | null;
  created_by: string;
  created_at: string;
  receipt_url?: string;
};

type LedgerAudit = {
  id: number;
  ledger_entry_id: string;
  action: "created" | "updated" | "deleted";
  actor_name: string;
  changed_at: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown>;
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
  const [auditLogs, setAuditLogs] = useState<LedgerAudit[]>([]);
  const [auditMessage, setAuditMessage] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [entryType, setEntryType] = useState<"income" | "expense">("expense");
  const [mobileEntryOpen, setMobileEntryOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [enteredByName, setEnteredByName] = useState("");
  const [note, setNote] = useState("");
  const [entryDate, setEntryDate] = useState(localDateValue());
  const [receipt, setReceipt] = useState<File | null>(null);
  const [editingEntry, setEditingEntry] = useState<LedgerEntry | null>(null);
  const [editorName, setEditorName] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsUnlocked, setSettingsUnlocked] = useState(false);
  const [settingsPasswordConfigured, setSettingsPasswordConfigured] = useState<boolean | null>(null);
  const [settingsResetMode, setSettingsResetMode] = useState(false);
  const [accountPassword, setAccountPassword] = useState("");
  const [settingsPassphrase, setSettingsPassphrase] = useState("");
  const [settingsConfirmPassphrase, setSettingsConfirmPassphrase] = useState("");
  const [settingsMessage, setSettingsMessage] = useState("");
  const [deleteActorName, setDeleteActorName] = useState("");
  const [backgroundImage, setBackgroundImage] = useState("");
  const [backgroundUrlInput, setBackgroundUrlInput] = useState("");

  useEffect(() => {
    try {
      const savedBackground = localStorage.getItem("community-ledger-background") ?? "";
      if (savedBackground.startsWith("https://") || savedBackground.startsWith("http://")) {
        setBackgroundImage(savedBackground);
        setBackgroundUrlInput(savedBackground);
      } else if (savedBackground) {
        localStorage.removeItem("community-ledger-background");
      }
    } catch {
      setBackgroundImage("");
    }
  }, []);

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
      setAuditLogs([]);
      setCheckingAccess(false);
      return;
    }

    let cancelled = false;
    const client = supabase;
    const currentUser = user;

    async function loadLedger() {
      setCheckingAccess(true);
      setMessage("");

      const { data: membership, error: accessError } = await client
        .from("ledger_members")
        .select("can_record")
        .eq("user_id", currentUser.id)
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
        .select("id,entry_type,amount,category,entered_by_name,note,entry_date,receipt_path,created_by,created_at")
        .is("deleted_at", null)
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
      const { data: auditData, error: auditError } = await client
        .from("ledger_entry_audit")
        .select("id,ledger_entry_id,action,actor_name,changed_at,old_values,new_values")
        .order("changed_at", { ascending: false })
        .limit(40);
      if (cancelled) return;
      if (auditError) {
        setAuditLogs([]);
        setAuditMessage("İşlem geçmişi şu anda alınamıyor.");
      } else {
        setAuditLogs((auditData ?? []) as LedgerAudit[]);
        setAuditMessage("");
      }
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
    setSettingsOpen(false);
    setSettingsUnlocked(false);
    setSettingsPassphrase("");
    setSettingsConfirmPassphrase("");
    setAccountPassword("");
    setBusy(true);
    const { error } = await supabase.auth.signOut();
    setMessage(error ? "Oturum kapatılamadı. Yeniden deneyin." : "");
    setBusy(false);
  }

  async function openSettings() {
    setSettingsOpen(true);
    setSettingsUnlocked(false);
    setSettingsResetMode(false);
    setSettingsPassphrase("");
    setSettingsConfirmPassphrase("");
    setAccountPassword("");
    setSettingsPasswordConfigured(null);
    setSettingsMessage("");
    if (!supabase) return;
    const { data, error } = await supabase.rpc("ledger_settings_password_configured");
    if (error) {
      setSettingsMessage("Ayarlar kontrol edilemedi. Veritabanı kurulumu tamamlanmamış olabilir.");
      return;
    }
    setSettingsPasswordConfigured(Boolean(data));
  }

  async function unlockSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    if (settingsPasswordConfigured === false) {
      if (settingsPassphrase.length < 12 || settingsPassphrase.length > 128) {
        setSettingsMessage("Yeni şifre 12–128 karakter olmalı.");
        return;
      }
      if (settingsPassphrase !== settingsConfirmPassphrase) {
        setSettingsMessage("Şifreler eşleşmiyor.");
        return;
      }
      const { error } = await supabase.rpc("set_ledger_settings_password", { p_password: settingsPassphrase });
      if (error) {
        setSettingsMessage("Şifre kaydedilemedi. Bu yönetici hesabıyla giriş yaptığınızı kontrol edin.");
        return;
      }
      setSettingsPasswordConfigured(true);
      setSettingsUnlocked(true);
      setSettingsConfirmPassphrase("");
      setSettingsMessage("Yeni ayar şifresi güvenli biçimde kaydedildi.");
      return;
    }
    const { data, error } = await supabase.rpc("verify_ledger_settings_password", { p_password: settingsPassphrase });
    if (error || !data) {
      setSettingsMessage("Şifre hatalı veya geçici olarak kilitlendi. Tekrar deneyin.");
      setSettingsPassphrase("");
      return;
    }
    setSettingsUnlocked(true);
    setSettingsMessage("");
  }

  async function resetSettingsPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !user?.email) return;
    if (settingsPassphrase.length < 12 || settingsPassphrase.length > 128) {
      setSettingsMessage("Yeni şifre 12–128 karakter olmalı.");
      return;
    }
    if (settingsPassphrase !== settingsConfirmPassphrase) {
      setSettingsMessage("Yeni şifreler eşleşmiyor.");
      return;
    }
    setBusy(true);
    setSettingsMessage("");
    const { error: authError } = await supabase.auth.signInWithPassword({ email: user.email, password: accountPassword });
    if (authError) {
      setBusy(false);
      setSettingsMessage("Hesap şifresi doğrulanamadı.");
      return;
    }
    const { error } = await supabase.rpc("reset_ledger_settings_password", { p_password: settingsPassphrase });
    setBusy(false);
    if (error) {
      setSettingsMessage("Yeni ayar şifresi kaydedilemedi.");
      return;
    }
    setSettingsUnlocked(true);
    setSettingsResetMode(false);
    setAccountPassword("");
    setSettingsConfirmPassphrase("");
    setSettingsMessage("Ayar şifresi yenilendi.");
  }

  function applyBackgroundUrl() {
    const input = backgroundUrlInput.trim();
    try {
      const parsed = new URL(input);
      if (!(parsed.protocol === "https:" || parsed.protocol === "http:")) throw new Error("Invalid protocol");
      const safeUrl = parsed.href;
      localStorage.setItem("community-ledger-background", safeUrl);
      setBackgroundImage(safeUrl);
      setBackgroundUrlInput(safeUrl);
      setSettingsMessage("Arka plan URL’si bu tarayıcıda kaydedildi.");
    } catch {
      setSettingsMessage("Geçerli bir http:// veya https:// görsel URL’si girin.");
    }
  }

  function resetBackground() {
    localStorage.removeItem("community-ledger-background");
    setBackgroundImage("");
    setBackgroundUrlInput("");
    setSettingsMessage("Varsayılan arka plan geri yüklendi.");
  }

  async function deleteAllEntries() {
    if (!supabase || !canRecord) return;
    const actorName = deleteActorName.trim();
    if (!actorName) {
      setSettingsMessage("Silme işlemini yapan kişinin adını yazın.");
      return;
    }
    if (actorName.length > 80) {
      setSettingsMessage("İsim en fazla 80 karakter olabilir.");
      return;
    }
    if (entries.length === 0) {
      setSettingsMessage("Silinecek kayıt yok.");
      return;
    }
    if (!window.confirm(`${entries.length} kasa kaydı görünümden kaldırılacak. Kayıtlar ve fişleri saklanacak; silme işlemi işlem geçmişinde kalacak. Devam edilsin mi?`)) return;
    setBusy(true);
    setSettingsMessage("");
    const { data, error } = await supabase.rpc("delete_all_ledger_entries", { p_actor_name: actorName, p_password: settingsPassphrase });
    if (error) {
      setBusy(false);
      setSettingsMessage("Kayıtlar görünümden kaldırılamadı. Sunucu şeması güncel olmayabilir; yöneticiyle iletişime geçin.");
      return;
    }
    setBusy(false);
    setDeleteActorName("");
    setSettingsMessage(`${Number(data ?? 0)} kayıt görünümden kaldırıldı; kayıtlar, fişler ve silme geçmişi saklanıyor.`);
    setRefreshKey((value) => value + 1);
  }

  function resetEntryForm() {
    setEditingEntry(null);
    setMobileEntryOpen(false);
    setAmount("");
    setCategory("");
    setEnteredByName("");
    setEditorName("");
    setNote("");
    setEntryDate(localDateValue());
    setReceipt(null);
    const fileInput = document.getElementById("receipt") as HTMLInputElement | null;
    if (fileInput) fileInput.value = "";
  }

  function beginEdit(entry: LedgerEntry) {
    setEditingEntry(entry);
    if (window.matchMedia("(max-width: 760px)").matches) setMobileEntryOpen(true);
    setEntryType(entry.entry_type);
    setAmount(String(entry.amount));
    setCategory(entry.category);
    setEditorName("");
    setNote(entry.note ?? "");
    setEntryDate(entry.entry_date);
    setReceipt(null);
    setFormMessage("");
    const fileInput = document.getElementById("receipt") as HTMLInputElement | null;
    if (fileInput) fileInput.value = "";
    document.getElementById("entry-form-title")?.scrollIntoView({ behavior: "smooth", block: "center" });
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
    const attributionName = editingEntry ? editorName.trim() : enteredByName.trim();
    if (!attributionName) {
      setFormMessage(editingEntry ? "Düzenlemeyi yapan kişinin adını yazın." : "Kaydı ekleyen kişinin adını yazın.");
      return;
    }
    if (attributionName.length > 80) {
      setFormMessage("İsim en fazla 80 karakter olabilir.");
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
    let receiptPath: string | null = editingEntry?.receipt_path ?? null;

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

    const result = editingEntry
      ? await supabase.from("ledger_entries").update({
          entry_type: entryType,
          amount: numericAmount,
          category: category.trim(),
          updated_by_name: attributionName,
          note: note.trim() || null,
          entry_date: entryDate,
          receipt_path: receiptPath,
        }).eq("id", editingEntry.id)
      : await supabase.from("ledger_entries").insert({
          entry_type: entryType,
          amount: numericAmount,
          category: category.trim(),
          entered_by_name: attributionName,
          note: note.trim() || null,
          entry_date: entryDate,
          receipt_path: receiptPath,
          created_by: user.id,
        });

    if (result.error) {
      setFormMessage(editingEntry ? "Düzenleme kaydedilemedi. Hesap yetkinizi kontrol edip yeniden deneyin." : "Kayıt eklenemedi. Hesap yetkinizi kontrol edin ve yeniden deneyin.");
      setBusy(false);
      return;
    }

    const wasEditing = Boolean(editingEntry);
    resetEntryForm();
    setFormMessage(wasEditing ? "Düzenleme kaydedildi ve geçmişe eklendi." : "Kayıt eklendi.");
    setRefreshKey((value) => value + 1);
    setBusy(false);
  }

  return (
    <main className="page-shell" style={backgroundImage ? { "--user-background": `url("${backgroundImage.replace(/[\\"\n\r]/g, "\\$&")}")` } as CSSProperties : undefined}>
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
              <img className="mark small brand-mark-image" src="https://i.hizliresim.com/3jbtlkgx.png" alt="" aria-hidden="true" />
              <div><p className="eyebrow">TOPLULUK YÖNETİMİ</p><h1>Topluluk Bütçesi</h1></div>
            </div>
            <div className="account-menu"><span title={user.email ?? undefined}>{user.email}</span><button className="button settings-button" type="button" onClick={openSettings}>Ayarlar</button><button className="button logout-button" onClick={handleSignOut} disabled={busy}>Çıkış</button></div>
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
                <div className="welcome-actions">
                  <button className="mobile-entry-toggle" type="button" onClick={() => setMobileEntryOpen(true)} aria-label="Gelir veya gider kaydı aç">
                    <span className="hamburger-icon" aria-hidden="true"><i /><i /><i /></span><span>Kayıt ekle</span>
                  </button>
                  <div className="entry-count">{entries.length}<span> kayıt</span></div>
                </div>
              </section>

              <section className="summary-grid" aria-label="Bakiye özeti">
                <article className="summary-card income-card"><span>Toplam gelir</span><strong className="income-text">{formatMoney(totals.income)}</strong><small>Kaydedilen tüm gelirler</small></article>
                <article className="summary-card balance-card"><span>Güncel bakiye</span><strong>{formatMoney(totals.balance)}</strong><small>Toplam gelir − toplam gider</small></article>
                <article className="summary-card expenses-card"><span>Masraflar</span><strong className="expense-text">{formatMoney(totals.expense)}</strong><small>Kaydedilen tüm masraflar</small></article>
              </section>

              {mobileEntryOpen && <button className="mobile-entry-backdrop" type="button" aria-label="Kayıt formunu kapat" onClick={() => setMobileEntryOpen(false)} />}
              <div className="content-grid">
                <section className={`panel form-panel${mobileEntryOpen ? " mobile-entry-open" : ""}`} aria-labelledby="entry-form-title">
                  <div className="panel-heading"><div><p className="eyebrow">{editingEntry ? "KAYDI GÜNCELLE" : "YENİ HAREKET"}</p><h2 id="entry-form-title">{editingEntry ? "Kaydı düzenle" : "Kayıt ekle"}</h2></div><div className="form-heading-actions"><div className="plus-mark" aria-hidden="true">{editingEntry ? "↻" : "＋"}</div><button className="icon-button mobile-entry-close" type="button" aria-label="Kayıt formunu kapat" onClick={() => setMobileEntryOpen(false)}>×</button></div></div>
                  <form className="entry-form" onSubmit={handleCreateEntry}>
                    <fieldset className="type-switch">
                      <legend>Kayıt türü</legend>
                      <button type="button" aria-pressed={entryType === "income"} className={entryType === "income" ? "type-choice selected income-choice" : "type-choice"} onClick={() => setEntryType("income")}>Gelir</button>
                      <button type="button" aria-pressed={entryType === "expense"} className={entryType === "expense" ? "type-choice selected expense-choice" : "type-choice"} onClick={() => setEntryType("expense")}>Gider</button>
                    </fieldset>
                    <label htmlFor="amount">Tutar <span>₺</span></label>
                    <div className="amount-field"><input id="amount" type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0,00" required /><span>TRY</span></div>
                    <label htmlFor="category">İşlem adı</label>
                    <input id="category" value={category} onChange={(event) => setCategory(event.target.value)} maxLength={80} required />
                    <label htmlFor={editingEntry ? "editor-name" : "entered-by-name"}>{editingEntry ? "Düzenlemeyi yapan kişi" : "Kaydı ekleyen kişi"}</label>
                    <input id={editingEntry ? "editor-name" : "entered-by-name"} value={editingEntry ? editorName : enteredByName} onChange={(event) => editingEntry ? setEditorName(event.target.value) : setEnteredByName(event.target.value)} maxLength={80} placeholder="Ad soyad" autoComplete="name" required />
                    <label htmlFor="entry-date">Tarih</label>
                    <input id="entry-date" type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} required />
                    <label htmlFor="note">Açıklama <span>İsteğe bağlı</span></label>
                    <textarea id="note" rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Toplu gelir veya gider girişlerinde açıklamayı buraya yazın." />
                    <label htmlFor="receipt">Fiş görseli <span>İsteğe bağlı</span></label>
                    {editingEntry?.receipt_path && !receipt && <p className="receipt-preserved">Mevcut fiş korunacak. Yeni bir görsel seçerek değiştirebilirsiniz.</p>}
                    <label className="file-drop" htmlFor="receipt">
                      <span className="file-icon" aria-hidden="true">↑</span>
                      <span><strong>{receipt ? receipt.name : "Görsel seçin"}</strong><small>JPG, PNG veya WebP · en fazla 8 MB</small></span>
                      <input id="receipt" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setReceipt(event.currentTarget.files?.[0] ?? null)} />
                    </label>
                    {formMessage && <p className={formMessage === "Kayıt eklendi." ? "message success-message" : "message"} role="status">{formMessage}</p>}
                    <button className="button submit-button" type="submit" disabled={busy}>{busy ? "Kaydediliyor…" : editingEntry ? "Değişiklikleri kaydet" : "Kaydı ekle"}</button>
                    {editingEntry && <button className="button secondary cancel-edit-button" type="button" disabled={busy} onClick={() => { resetEntryForm(); setFormMessage(""); }}>Düzenlemeden vazgeç</button>}
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
                          <div className="entry-main"><strong>{entry.category}</strong><span>{formatDate(entry.entry_date)} · Ekleyen: {entry.entered_by_name || "Belirtilmemiş"}{entry.note ? ` · ${entry.note}` : ""}</span>{entry.receipt_path && (entry.receipt_url ? <a className="receipt-link" href={entry.receipt_url} target="_blank" rel="noreferrer">Fiş görselini aç ↗</a> : <small className="receipt-unavailable">Fiş görseli şu anda açılamıyor</small>)}</div>
                          <div className="entry-actions"><strong className={entry.entry_type === "income" ? "entry-amount income-text" : "entry-amount expense-text"}>{entry.entry_type === "income" ? "+" : "−"}{formatMoney(Number(entry.amount))}</strong><button className="edit-button" type="button" onClick={() => beginEdit(entry)} disabled={busy} aria-label={`${entry.category} kaydını düzenle`}>Düzenle</button></div>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </div>
              <section className="panel audit-panel" aria-labelledby="audit-title">
                <div className="panel-heading"><div><p className="eyebrow">KAYIT İZİ</p><h2 id="audit-title">İşlem geçmişi</h2></div><span className="secure-label"><span /> Son 40 işlem</span></div>
                {auditMessage && <p className="message history-message" role="status">{auditMessage}</p>}
                {!auditMessage && auditLogs.length === 0 ? <p className="audit-empty">Henüz kaydedilmiş işlem geçmişi yok. Eklenen, düzenlenen ve görünümden kaldırılan hareketler burada görünür.</p> : (
                  <div className="audit-list">
                    {auditLogs.map((log) => {
                      const before = log.old_values ?? {};
                      const after = log.new_values ?? {};
                      const fields: Array<[string, string]> = [["entry_type", "Tür"], ["amount", "Tutar"], ["category", "İşlem adı"], ["entry_date", "Tarih"], ["note", "Açıklama"], ["receipt_path", "Fiş"]];
                      const changes = log.action === "created" ? `Yeni ${after.entry_type === "income" ? "gelir" : "gider"}: ${String(after.category ?? "")} · ${formatMoney(Number(after.amount ?? 0))}` : fields.filter(([key]) => before[key] !== after[key]).map(([key, label]) => `${label}: ${key === "amount" ? `${formatMoney(Number(before[key] ?? 0))} → ${formatMoney(Number(after[key] ?? 0))}` : key === "entry_type" ? `${before[key] === "income" ? "Gelir" : "Gider"} → ${after[key] === "income" ? "Gelir" : "Gider"}` : key === "receipt_path" ? `${before[key] ? "Değiştirildi" : "Yüklendi"}` : `${String(before[key] ?? "—")} → ${String(after[key] ?? "—")}`}`).join(" · ") || "Kayıt güncellendi";
                      const actionLabel = log.action === "created" ? "ekledi" : log.action === "deleted" ? "sildi" : "düzenledi";
                      const detail = log.action === "deleted" ? `Silinen kayıt: ${String(before.category ?? after.category ?? "")} · ${formatMoney(Number(before.amount ?? after.amount ?? 0))}` : changes;
                      return <article className="audit-row" key={log.id}><span className={log.action === "created" ? "audit-dot created" : log.action === "deleted" ? "audit-dot deleted" : "audit-dot updated"} aria-hidden="true" /><div className="audit-detail"><strong>{log.actor_name} <span>{actionLabel}</span></strong><p>{detail}</p></div><time dateTime={log.changed_at}>{new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(log.changed_at))}</time></article>;
                    })}
                  </div>
                )}
              </section>
              <p className="privacy-note"><span aria-hidden="true">◈</span> Kasa kayıtları ve fiş görselleri yalnızca yetkilendirilmiş hesaplara açıktır.</p>
              {settingsOpen && <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
                <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
                  <div className="panel-heading"><div><p className="eyebrow">TERCİHLER VE YÖNETİM</p><h2 id="settings-title">Ayarlar</h2></div><button className="icon-button" type="button" aria-label="Ayarları kapat" onClick={() => { setSettingsOpen(false); setSettingsPassphrase(""); setSettingsConfirmPassphrase(""); setAccountPassword(""); }}>×</button></div>
                  {settingsPasswordConfigured === null ? <p className="status" role="status">Ayarlar doğrulanıyor…</p> : !settingsUnlocked && settingsPasswordConfigured && !settingsResetMode ? <><form className="settings-form" onSubmit={unlockSettings}><p className="muted">Ayarları açmak için şifrenizi girin.</p><label htmlFor="settings-password">Ayar şifresi</label><input id="settings-password" type="password" value={settingsPassphrase} onChange={(event) => setSettingsPassphrase(event.target.value)} maxLength={128} autoComplete="current-password" required /><button className="button" type="submit">Ayarları aç</button></form><button className="text-button reset-password-button" type="button" onClick={() => { setSettingsResetMode(true); setSettingsMessage(""); }}>Ayar şifresini yenile</button></> : !settingsUnlocked ? <form className="settings-form" onSubmit={settingsResetMode ? resetSettingsPassword : unlockSettings}><p className="muted">{settingsResetMode ? "Hesap şifreni tekrar doğrula ve yeni ayar şifresi belirle." : "İlk kullanım: kendine özel bir ayar şifresi oluştur."}</p>{settingsResetMode && <><label htmlFor="account-password">Hesap şifresi</label><input id="account-password" type="password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} autoComplete="current-password" required /></>}<label htmlFor="settings-password">Yeni ayar şifresi (en az 12 karakter)</label><input id="settings-password" type="password" value={settingsPassphrase} onChange={(event) => setSettingsPassphrase(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" required /><label htmlFor="settings-password-confirm">Şifreyi tekrar girin</label><input id="settings-password-confirm" type="password" value={settingsConfirmPassphrase} onChange={(event) => setSettingsConfirmPassphrase(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" required /><button className="button" type="submit" disabled={busy}>{busy ? "Kaydediliyor…" : settingsResetMode ? "Şifreyi doğrula ve yenile" : "Şifreyi kaydet ve aç"}</button></form> : <div className="settings-content">
                    <section className="settings-section"><h3>Arka plan</h3><p>Görsel bağlantısını girin. URL yalnızca bu tarayıcıda saklanır.</p><label htmlFor="background-url">Görsel URL’si</label><input id="background-url" type="url" inputMode="url" value={backgroundUrlInput} onChange={(event) => setBackgroundUrlInput(event.target.value)} placeholder="https://ornek.com/arka-plan.jpg" autoComplete="url" /><button className="button settings-action" type="button" onClick={applyBackgroundUrl}>URL’yi uygula</button>{backgroundImage && <button className="button secondary settings-action" type="button" onClick={resetBackground}>Varsayılan arka plana dön</button>}</section>
                    <section className="settings-section danger-zone"><h3>Kasa kayıtlarını sil</h3><p>Tüm gelir ve gider kayıtları görünümden kaldırılır. Kayıtlar ve fişler saklanır; silme işlemi ve yapan kişinin adı işlem geçmişinde kalır.</p><label htmlFor="delete-actor-name">İşlemi yapan kişi</label><input id="delete-actor-name" value={deleteActorName} onChange={(event) => setDeleteActorName(event.target.value)} maxLength={80} placeholder="Ad soyad" autoComplete="name" /><button className="button danger-button" type="button" onClick={deleteAllEntries} disabled={busy || entries.length === 0}>{busy ? "Kaldırılıyor…" : `Tüm kayıtları kaldır (${entries.length})`}</button></section>
                  </div>}
                  {settingsMessage && <p className={settingsMessage.includes("kaldırıldı") || settingsMessage.includes("kaydedildi") || settingsMessage.includes("geri yüklendi") ? "message success-message" : "message"} role="status">{settingsMessage}</p>}
                </section>
              </div>}
            </>
          )}
        </div>
      )}
    </main>
  );
}

