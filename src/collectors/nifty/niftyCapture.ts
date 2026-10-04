import { TARGET_PREFECTURES } from "../shared/targetCities";

/** Public DOM projection, shared by the human CLI and native-browser workflow. */
export function niftyCaptureExpression(url: string): string {
  return `(async()=>{
    const url=${JSON.stringify(url)};
    const prefectures=${JSON.stringify(TARGET_PREFECTURES)};
    let doc=document;
    if(new URL(location.href).href!==url){
      const res=await fetch(url,{credentials:'include',signal:AbortSignal.timeout(20000)});
      if(!res.ok)throw Error('Nifty HTTP '+res.status);
      doc=new DOMParser().parseFromString(await res.text(),'text/html');
    }
    if(doc.querySelector('select[name="sort"]')?.value!=='regDate-desc')throw Error('Newest-first sort not confirmed');
    const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const badges=root=>[...root.querySelectorAll('.badge.is-outline')].map(b=>'<span class="badge is-outline">'+esc(b.textContent.trim())+'</span>').join('');
    // Lazy photos: building thumbnail in the header, building + floor plan per room. The parser drops "no image" art.
    const photos=(root,selector)=>[...root.querySelectorAll(selector)].map(i=>'<img class="'+(i.classList.contains('thumbnail-parent')?'thumbnail-parent':'thumbnail')+'" data-src="'+esc(i.getAttribute('data-src')||i.getAttribute('src'))+'" alt="'+esc(i.getAttribute('alt'))+'">').join('');
    const tables=[...doc.querySelectorAll('.result-bukken-table')];
    if(!tables.length)throw Error('No Nifty property tables; not exhaustion');
    return tables.map(table=>{
      const header=table.parentElement.firstElementChild;
      const address=[...header.querySelectorAll('p')].find(p=>prefectures.some(pref=>p.textContent.trim().startsWith(pref)));
      const dl=[...header.querySelectorAll('dl')].map(d=>'<dl><dt>'+esc(d.querySelector('dt')?.textContent.trim())+'</dt><dd>'+esc(d.querySelector('dd')?.textContent.trim())+'</dd></dl>').join('');
      const station=header.querySelector('[data-transport-access]')?.textContent.trim();
      const rows=[...table.querySelectorAll('tbody.click-area')].map(body=>{
        const cells=[...body.querySelector('tr').children];
        const href=body.querySelector('a[href*="detail_"]')?.getAttribute('href');
        if(!href)return '';
        const cell=(i)=>cells[i]?'<td'+(i===4?' class="bukken-info-rent"':'')+'>'+cells[i].innerHTML+'</td>':'';
        return '<tbody class="click-area"><tr><td></td><td></td>'+[2,3,4,5].map(cell).join('')+'</tr><tr><td>'+badges(body)+photos(body,'img.thumbnail, img.thumbnail-parent')+'<a href="'+esc(href)+'">detail</a></td></tr></tbody>';
      }).join('');
      return '<div class="card"><header><h2>'+esc(header.querySelector('h2')?.textContent.trim())+'</h2><p>'+esc(address?.textContent.trim())+'</p><li data-transport-access>'+esc(station)+'</li>'+dl+badges(header)+photos(header,'img.thumbnail')+'</header><table class="result-bukken-table">'+rows+'</table></div>';
    }).join('');
  })()`;
}
