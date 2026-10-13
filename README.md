# Topluluk Bütçesi

Topluluk gelir ve gider kayıtlarını Supabase Auth, Postgres ve özel Storage alanı ile yöneten web uygulaması.

## Yerel çalıştırma

1. Node.js ve pnpm kurulu bir ortamda `pnpm install` çalıştırın.
2. `.env.example` dosyasını `.env.local` olarak kopyalayın ve Supabase proje URL’si ile publishable anahtarı girin.
3. `pnpm dev` ile yerel geliştirme sunucusunu başlatın.

## GitHub Pages yayını

Depoda GitHub Pages için bir Actions iş akışı bulunur. Depo ayarlarında **Pages → Build and deployment → Source** değerini **GitHub Actions** seçin. Ardından **Settings → Secrets and variables → Actions → Variables** bölümünde şu repository variables değerlerini tanımlayın:

- `VITE_SUPABASE_URL`: Supabase proje URL’si.
- `VITE_SUPABASE_PUBLISHABLE_KEY`: Supabase publishable key.

`main` dalına yapılan push, uygulamayı GitHub Pages’te yayımlar. `.env.local` yerel kalır ve depoya eklenmez.

E-posta doğrulamasının doğru siteye dönmesi için Supabase **Authentication → URL Configuration** bölümünde Site URL olarak `https://osmanbarissarikaya1-lang.github.io/topluluk-butce/` adresini, Redirect URLs listesine de aynı adresi ekleyin.

Bu proje, bağlı Supabase veritabanına `supabase/setup.sql` şemasıyla kuruldu. Fiş görselleri `community-receipts` adlı özel bucket içinde saklanır. Dosya türü JPG, PNG veya WebP; en büyük dosya boyutu 8 MB’tır.

## Üye erişimi

Hesap girişi Supabase Auth üzerinden yapılır. Bir kullanıcının kayıtları görüntüleyip ekleyebilmesi için `public.ledger_members` tablosunda yetkili bir satırı bulunmalıdır. Bu tabloya uygulamanın tarayıcı kodundan yazma izni verilmez. Yetkilendirilecek hesapları belirlemek için yöneticinin e-posta adreslerini paylaşması gerekir.
