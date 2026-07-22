// ============================================================
// Uvoz pitanja iz docx fajla u questions.json
// Pokreni: node scripts/import-questions.js [putanja-do-docx]
// ============================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const inputDocx = process.argv[2] || path.join(__dirname, '..', 'Baza_pitanja_CPC_sa_URL.docx');
const outputJson = path.join(__dirname, '..', 'data', 'questions.json');

if (!fs.existsSync(inputDocx)) {
  console.error(`Fajl ne postoji: ${inputDocx}`);
  process.exit(1);
}

console.log(`Čitam: ${inputDocx}`);

// Koristimo `unzip + parse XML` pristup jer Replit ne mora imati python
// Alternativa: koristi 'mammoth' npm paket
// Ovde idem sa jednostavnim XML parserom

const AdmZip = require('adm-zip');
let zip;
try {
  zip = new AdmZip(inputDocx);
} catch (e) {
  console.error('Greška pri otvaranju docx (treba adm-zip):', e.message);
  console.error('Instaliraj: npm install adm-zip');
  process.exit(1);
}

const docXml = zip.readAsText('word/document.xml');
if (!docXml) {
  console.error('Ne mogu da pročitam word/document.xml');
  process.exit(1);
}

// Izvuci tekst paragrafa (svaki <w:p>...</w:p>)
const paragraphTexts = [];
const pRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
const matches = docXml.match(pRegex) || [];

for (const p of matches) {
  // Sakupi sav tekst unutar <w:t>...</w:t>
  const tRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
  let text = '';
  let m;
  while ((m = tRegex.exec(p)) !== null) {
    text += m[1];
  }
  // Dekoduj XML entitete
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
  paragraphTexts.push(text);
}

console.log(`Pročitano ${paragraphTexts.length} paragrafa`);

// Parsiranje pitanja
const questions = [];
const themes = [];
let currentTheme = null;

const qPattern = /^(\d+)\.\s*(?:⚠️\s*)?(.+)$/;
const themePattern = /^([А-ЯЁA-Za-zŠĐČĆŽšđčćž][А-ЯЁA-Za-zŠĐČĆŽšđčćž\s]+?)\s*\(\d+\s*питања?\)$/;
const optPattern = /^([абвг])\)\s*(.+)$/;
const correctPattern = /^Тачан одговор:\s*([абвг])\)\s*(.*)$/;
const explPattern = /^Образложење:\s*(.+)$/;
const imgPattern = /\[SLIKA:\s*([^\]]+)\]/;

let current = null;

for (let i = 0; i < paragraphTexts.length; i++) {
  const text = paragraphTexts[i];
  if (!text) continue;

  // Detekcija teme
  const tm = text.match(themePattern);
  if (tm) {
    currentTheme = tm[1].trim();
    themes.push({ name: currentTheme });
    if (current) { questions.push(current); current = null; }
    continue;
  }

  // Detekcija pitanja
  const qm = text.match(qPattern);
  if (qm) {
    if (current) questions.push(current);
    let title = qm[2].trim();
    let imageUrl = null;
    const im = title.match(imgPattern);
    if (im) {
      imageUrl = im[1].trim();
      title = title.replace(imgPattern, '').trim();
    }
    current = {
      num: parseInt(qm[1]),
      title,
      options: {},
      correct: null,
      explanation: null,
      image_url: imageUrl,
      theme: currentTheme
    };
    continue;
  }

  if (!current) continue;

  // Opcije
  const om = text.match(optPattern);
  if (om) {
    current.options[om[1]] = om[2].trim();
    continue;
  }

  // Tačan odgovor
  const cm = text.match(correctPattern);
  if (cm) {
    current.correct = cm[1];
    continue;
  }

  // Obrazloženje
  const em = text.match(explPattern);
  if (em) {
    // Ukloni napomenu (⚠️ NAPOMENA: ...)
    let exp = em[1];
    const noteIdx = exp.indexOf('⚠️ NAPOMENA:');
    if (noteIdx >= 0) exp = exp.slice(0, noteIdx).trim();
    current.explanation = exp;
    continue;
  }
}

if (current) questions.push(current);

console.log(`Parsirano ${questions.length} pitanja u ${themes.length} tema`);

// Validacija
const bad = questions.filter(q => !q.correct || Object.keys(q.options).length !== 4);
if (bad.length) {
  console.warn(`⚠️  ${bad.length} pitanja imaju problem:`);
  bad.slice(0, 5).forEach(q => {
    console.warn(`   #${q.num}: opcije=${Object.keys(q.options).length}, tačan=${q.correct}`);
  });
}

// Renumeracija (za svaki slučaj 1-N)
questions.forEach((q, i) => {
  q.original_num = q.num;
  q.num = i + 1;
});

// Sačuvaj
const out = { questions, themes, total: questions.length, generated_at: new Date().toISOString() };
fs.mkdirSync(path.dirname(outputJson), { recursive: true });
fs.writeFileSync(outputJson, JSON.stringify(out, null, 1), 'utf-8');

console.log(`✓ Sačuvano u ${outputJson}`);
console.log(`  Ukupno: ${questions.length} pitanja`);
console.log(`  Tema: ${themes.map(t => t.name).join(', ')}`);
const withImages = questions.filter(q => q.image_url).length;
console.log(`  Sa slikama: ${withImages}`);
