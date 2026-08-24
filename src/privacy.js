import { el } from './ui.js';

export function renderPrivacy() {
  const view = document.querySelector('#privacy-view');
  if (!view) return;
  view.innerHTML = '';
  view.append(
    el('div', { className: 'page sidebar-page' }, [
      el('section', { className: 'panel stack privacy-panel' }, [
        el('h2', { text: 'Integritet' }),
        el('p', { text: 'Fältchatt är en enkel gruppapp för fältarbete där medlemmar kan dela kartor, chatt och position inom en vald grupp.' }),
        el('h3', { text: 'Uppgifter som lagras' }),
        el('p', { text: 'Appen lagrar profilens alias, vald symbol, symbolfärg, gruppmedlemskap, chatt, polls, uppladdade kartor och platsdata som du själv delar.' }),
        el('h3', { text: 'E-post' }),
        el('p', { text: 'E-post används bara av databasservern för inloggning, bekräftelse, lösenordsåterställning och eventuell kontovarning. Fältchatts vanliga tabeller lagrar inte e-postadresser.' }),
        el('h3', { text: 'Position' }),
        el('p', { text: 'Positionsdelning är frivillig och styrs i Profil. När den är på kan godkända medlemmar i samma grupp se din senast delade position.' }),
        el('h3', { text: 'Gruppdata' }),
        el('p', { text: 'Godkända gruppmedlemmar kan se gruppens medlemmar, chatt, polls, kartor och delade positioner. Owner och admin kan administrera gruppen.' }),
        el('h3', { text: 'Lagringstid och radering' }),
        el('p', { text: 'Du kan själv ta bort ditt konto via profilfliken. Då raderas ditt medlemskap och personuppgifter. Inaktiva konton raderas automatiskt efter 12 månader, med varning cirka 30 dagar innan när serverrutinen är aktiverad.' }),
      ]),
    ]),
  );
}
