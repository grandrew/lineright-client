/**
 * How the stand-in looks.
 *
 * Kept apart from the markup because it is long, cacheable and boring, and
 * served from its own URL the way a real site serves its stylesheet. The look
 * is the California state template: a thin CA.gov strip, a white masthead with
 * the seal, a blue service bar, cards on a pale background, and a dark footer.
 *
 * This matters more than it sounds. The desktop app opens this site in a
 * browser tab for the applicant to finish a booking by hand, so "what DMV looks
 * like" is part of what is being tested — a page of unstyled inputs exercises
 * the flow but tells you nothing about whether a person could follow it.
 *
 * The one thing it must never do is pretend to be the real site: the strip
 * carries a stand-in badge on every page, and the footer says so in words.
 */
export const CSS = `
:root{
  --navy:#0b2e4f; --blue:#046b99; --blue-dark:#034e70; --gold:#fdb81e;
  --ink:#17242f; --muted:#5b6b78; --line:#d3dce3; --bg:#eef2f5; --card:#fff;
  --good:#1b7a43; --warn:#9a3412; --warn-bg:#fff7ed;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.5 "Source Sans Pro","Helvetica Neue",Arial,sans-serif}
a{color:var(--blue)}
a:hover{color:var(--blue-dark)}
h1,h2,h3{line-height:1.25;margin:0 0 .5rem}
h1{font-size:1.9rem}
h2{font-size:1.35rem}
h3{font-size:1.1rem}
p{margin:0 0 1rem}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.skip{position:absolute;left:-9999px}
.skip:focus{left:8px;top:8px;background:#fff;padding:8px;z-index:9}

/* ---------------------------------------------------------------- header */
.ca-strip{background:var(--navy);color:#dbe7f1;font-size:.8rem}
.ca-strip .wrap{display:flex;align-items:center;gap:12px;min-height:34px;flex-wrap:wrap}
.ca-strip a{color:#dbe7f1;text-decoration:none}
.ca-strip a:hover{text-decoration:underline}
.ca-strip__gov{font-weight:700;letter-spacing:.02em}
.ca-strip__badge{background:var(--gold);color:#3b2c00;font-weight:700;border-radius:2px;
  padding:1px 7px;font-size:.72rem;letter-spacing:.03em;text-transform:uppercase}
.ca-strip__right{margin-left:auto;display:flex;gap:14px;align-items:center}
.masthead{background:#fff;border-bottom:3px solid var(--gold)}
.masthead .wrap{display:flex;align-items:center;gap:16px;padding-top:14px;padding-bottom:14px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:var(--ink)}
.brand__seal{width:46px;height:46px;flex:none}
.brand__state{display:block;font-size:.78rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.brand__dept{display:block;font-size:1.22rem;font-weight:700;color:var(--navy)}
.masthead__search{margin-left:auto;display:flex;gap:6px}
.masthead__search input{min-width:180px}
.mainnav{background:var(--blue)}
.mainnav .wrap{display:flex;gap:2px;flex-wrap:wrap}
.mainnav a{color:#fff;text-decoration:none;padding:11px 14px;font-size:.93rem;font-weight:600}
.mainnav a:hover{background:var(--blue-dark);color:#fff}
.mainnav a.is-current{background:var(--blue-dark);box-shadow:inset 0 -4px 0 var(--gold)}
.crumbs{font-size:.85rem;color:var(--muted);padding:12px 0 0}
.crumbs a{text-decoration:none}
.crumbs span{padding:0 6px;color:#9aa8b3}

/* ----------------------------------------------------------------- steps */
.steps{display:flex;list-style:none;margin:16px 0 20px;padding:0;gap:6px;flex-wrap:wrap}
.steps li{display:flex;align-items:center;gap:8px;font-size:.86rem;color:var(--muted);
  background:#fff;border:1px solid var(--line);border-radius:999px;padding:5px 14px 5px 6px}
.steps b{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;
  background:#e3eaef;color:var(--muted);font-size:.78rem}
.steps .is-done{color:var(--ink)}
.steps .is-done b{background:var(--good);color:#fff}
.steps .is-current{color:#fff;background:var(--blue);border-color:var(--blue)}
.steps .is-current b{background:#fff;color:var(--blue)}

/* ----------------------------------------------------------------- cards */
main{padding-bottom:40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;
  padding:22px 24px;margin:0 0 18px;box-shadow:0 1px 2px rgba(11,46,79,.06)}
.card--tight{padding:16px 18px}
.muted{color:var(--muted)}
.small{font-size:.87rem}
.lead{font-size:1.05rem;color:var(--muted)}
.row{display:flex;gap:18px;flex-wrap:wrap}
.row>*{flex:1 1 260px}
.grid-2{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.notice{background:#eef6fb;border-left:4px solid var(--blue);padding:12px 16px;border-radius:0 4px 4px 0;margin:0 0 16px}
.notice--warn{background:var(--warn-bg);border-left-color:var(--warn)}
.notice--good{background:#effaf3;border-left-color:var(--good)}
.tag{display:inline-block;background:#e8eef3;color:var(--muted);border-radius:3px;
  padding:2px 8px;font-size:.78rem;font-weight:600;letter-spacing:.02em}

/* --------------------------------------------------------------- buttons */
.btn{display:inline-block;padding:10px 18px;border:2px solid var(--blue);background:var(--blue);
  color:#fff;border-radius:4px;cursor:pointer;font:inherit;font-weight:600;text-decoration:none;
  line-height:1.2}
.btn:hover{background:var(--blue-dark);border-color:var(--blue-dark);color:#fff}
.btn:disabled{background:#c6d1da;border-color:#c6d1da;color:#eff3f6;cursor:not-allowed}
.btn.sec{background:#fff;color:var(--blue)}
.btn.sec:hover{background:#eef6fb;color:var(--blue-dark)}
.btn.link{background:none;border:none;color:var(--blue);padding:0;text-decoration:underline}
.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:18px}
:focus-visible{outline:3px solid #2b7fc0;outline-offset:2px}

/* ----------------------------------------------------------------- forms */
label{display:block;margin:14px 0 4px;font-weight:600;font-size:.92rem}
.hint{font-weight:400;color:var(--muted);font-size:.85rem;margin:0 0 4px}
input,select,textarea{padding:9px 10px;border:1px solid #93a3b0;border-radius:4px;
  font:inherit;background:#fff;color:var(--ink);max-width:100%}
input[type=text],input[type=email],input[type=tel],input:not([type]){min-width:min(320px,100%)}
.checkbox{display:flex;gap:9px;align-items:flex-start;margin:14px 0;font-weight:400}
.checkbox input{min-width:auto;margin-top:3px}
fieldset{border:0;margin:0;padding:0}
.field-error{color:var(--warn);font-weight:600}

/* --------------------------------------------------------------- offices */
.results{list-style:none;margin:18px 0 0;padding:0}
li.location-results__list-item{background:#fff;border:1px solid var(--line);border-radius:6px;
  padding:16px 18px;margin:0 0 12px;display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start}
.office__main{flex:1 1 320px}
.office__name{margin:0 0 4px;font-size:1.1rem}
.office__miles{color:var(--muted);font-weight:400;font-size:.9rem;margin-left:8px}
.office address{font-style:normal;color:var(--ink)}
.office__meta{color:var(--muted);font-size:.87rem;margin:6px 0 0}
.office__side{flex:0 0 190px;display:flex;flex-direction:column;gap:8px;align-items:stretch}
.office__side .btn{text-align:center}

/* -------------------------------------------------------------- calendar */
.calendar{min-height:260px}
.calendar__loading{color:var(--muted);display:flex;gap:10px;align-items:center}
.spinner{width:18px;height:18px;border:3px solid #cfdae3;border-top-color:var(--blue);
  border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.calendar__head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.calendar__month{margin:0;font-size:1.25rem}
.calendar__nav{background:#fff;border:1px solid var(--blue);color:var(--blue);border-radius:4px;
  padding:7px 12px;font:inherit;font-weight:600;cursor:pointer}
.calendar__nav:disabled{border-color:#c6d1da;color:#9aa8b3;cursor:not-allowed}
.calendar__grid{width:100%;border-collapse:collapse;table-layout:fixed}
.calendar__grid th{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);
  padding:6px 0;border-bottom:1px solid var(--line)}
.calendar__grid td{padding:4px;text-align:center;vertical-align:top;height:74px}
.day{width:100%;min-height:62px;border-radius:5px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:2px;font:inherit}
.day--open{background:#fff;border:2px solid var(--blue);color:var(--blue);font-weight:700;cursor:pointer}
.day--open:hover{background:var(--blue);color:#fff}
.day--none{background:#f4f7f9;border:1px solid var(--line);color:#9aa8b3}
.day__count{font-size:.72rem;font-weight:600;letter-spacing:.01em}
.day--closed{background:repeating-linear-gradient(135deg,#f4f7f9,#f4f7f9 6px,#eaeff3 6px,#eaeff3 12px);
  border:1px solid var(--line);color:#9aa8b3}
.legend{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted);font-size:.84rem;margin-top:14px}
.legend span{display:flex;align-items:center;gap:6px}
.swatch{width:14px;height:14px;border-radius:3px;display:inline-block}
.swatch--open{border:2px solid var(--blue)}
.swatch--none{background:#f4f7f9;border:1px solid var(--line)}

/* ----------------------------------------------------------------- times */
.times{margin:0 0 18px}
.times legend{font-weight:700;font-size:1rem;margin-bottom:8px;color:var(--navy)}
.times__list{display:flex;gap:10px;flex-wrap:wrap}
.time{background:#fff;border:2px solid var(--blue);color:var(--blue);border-radius:4px;
  padding:11px 18px;font:inherit;font-weight:600;cursor:pointer;min-width:108px}
.time:hover{background:#eef6fb}
.time[aria-pressed=true]{background:var(--blue);color:#fff}
.hold{display:flex;gap:10px;align-items:center;background:var(--warn-bg);
  border:1px solid #f0c088;border-radius:5px;padding:10px 14px;margin:0 0 18px;font-size:.93rem}
.hold b{font-variant-numeric:tabular-nums}

/* ---------------------------------------------------------------- review */
.summary{list-style:none;margin:0;padding:0}
.summary li{display:flex;gap:16px;padding:9px 0;border-bottom:1px solid var(--line)}
.summary li:last-child{border-bottom:0}
.summary dt,.summary .k{flex:0 0 170px;color:var(--muted);font-size:.9rem}
.summary .v{font-weight:600}
.ref{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:1.5rem;letter-spacing:.06em;
  color:var(--navy);font-weight:700}

/* ------------------------------------------------------------ the gate */
.gatebox{background:#fff;border:1px solid var(--line);border-radius:6px;padding:14px 16px;margin:0 0 18px;max-width:420px}
.recaptcha{display:flex;align-items:center;gap:14px;border:1px solid #d3d3d3;border-radius:3px;
  background:#f9f9f9;padding:10px 12px;box-shadow:0 0 4px rgba(0,0,0,.08)}
.recaptcha__box{display:flex;align-items:center;gap:12px;background:none;border:0;font:inherit;
  cursor:pointer;color:var(--ink);padding:0}
.recaptcha__tick{width:26px;height:26px;border:2px solid #c1c1c1;background:#fff;border-radius:2px;
  display:inline-block;position:relative}
.recaptcha__box.is-working .recaptcha__tick{border-top-color:var(--blue);border-radius:50%;
  animation:spin 1s linear infinite}
.recaptcha__box.is-done .recaptcha__tick{border-color:var(--good)}
.recaptcha__box.is-done .recaptcha__tick:after{content:"";position:absolute;left:7px;top:2px;
  width:8px;height:15px;border:solid var(--good);border-width:0 3px 3px 0;transform:rotate(45deg)}
.recaptcha__logo{margin-left:auto;text-align:center;color:#9aa8b3;font-size:.68rem;line-height:1.3}
.recaptcha__logo span{display:block;font-size:.62rem}

/* ---------------------------------------------------------------- footer */
.footer{background:var(--navy);color:#c8d7e4;margin-top:auto;padding:26px 0 30px;font-size:.9rem}
.footer a{color:#fff;text-decoration:none}
.footer a:hover{text-decoration:underline}
.footer__cols{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));margin-bottom:20px}
.footer h3{color:#fff;font-size:.95rem;margin-bottom:8px}
.footer ul{list-style:none;margin:0;padding:0;line-height:1.9}
.footer__note{border-top:1px solid #1d4972;padding-top:14px;color:#9fb7cc;font-size:.83rem}
body{display:flex;flex-direction:column;min-height:100vh}
main{flex:1 0 auto}

@media (max-width:640px){
  .masthead__search{display:none}
  .calendar__grid td{height:62px}
  .day{min-height:52px}
  h1{font-size:1.5rem}
}
`;

/** The state seal, near enough for a mock and obviously drawn by hand. */
export const SEAL = `<svg class="brand__seal" viewBox="0 0 64 64" role="img" aria-label="State of California">
  <circle cx="32" cy="32" r="30" fill="#0b2e4f"/>
  <circle cx="32" cy="32" r="26" fill="#1b4f7e"/>
  <path d="M14 42c6-10 12-14 18-14s12 4 18 14z" fill="#fdb81e"/>
  <circle cx="32" cy="22" r="6" fill="#fdb81e"/>
  <path d="M8 46h48v3H8z" fill="#0b2e4f"/>
</svg>`;
