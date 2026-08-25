import { el } from './ui.js';

export function privacyContent() {
  return el('div', { className: 'stack privacy-panel' }, [
    el('p', { text: 'Fältchatt är en enkel gruppapp för fältarbete där medlemmar kan dela kartor, chatt och position inom en vald grupp.' }),
    el('h3', { text: 'Uppgifter som lagras' }),
    el('p', { text: 'Appen lagrar profilens alias, vald symbol, symbolfärg, gruppmedlemskap, chatt, polls, uppladdade kartor och platsdata som du själv delar.' }),
    el('h3', { text: 'E-post' }),
    el('p', { text: 'E-post används bara av databasservern för inloggning, bekräftelse, lösenordsåterställning och eventuell kontovarning. Fältchatts vanliga tabeller lagrar inte e-postadresser.' }),
    el('h3', { text: 'Position' }),
    el('p', { text: 'Positionsdelning är frivillig och styrs i Profil. När den är på kan godkända medlemmar i samma pågående grupp se din senast delade position.' }),
    el('h3', { text: 'Gruppdata' }),
    el('p', { text: 'Godkända gruppmedlemmar kan se gruppens medlemmar, chatt, polls, kartor och delade positioner. Owner och admin kan administrera gruppen tills den går ut.' }),
    el('h3', { text: 'Tillfälliga grupper' }),
    el('p', { text: 'En grupp är en tillfällig fältsession och raderas automatiskt efter 7 dagar. Det går inte att förlänga gruppen; skapa en ny grupp för nästa tillfälle.' }),
    el('h3', { text: 'Begränsningar' }),
    el('p', { text: 'Max 30 personer kan vara approved eller pending i samma grupp. Max 30 pågående grupper kan finnas totalt. Pågående betyder att gruppens 7 dagar inte har gått ut.' }),
    el('h3', { text: 'Radering' }),
    el('p', { text: 'När en grupp raderas tas medlemskap, chatt, polls, positioner, platsnålar och uppladdade GeoTIFF-kartor bort. Cleanup körs server-side och behöver inte ske exakt när gruppen går ut.' }),
    el('h3', { text: 'Konto' }),
    el('p', { text: 'Du kan själv ta bort ditt konto via profilfliken. Då raderas ditt medlemskap och personuppgifter. Inaktiva konton raderas automatiskt efter 12 månader när serverrutinen är aktiverad.' }),
  ]);
}
