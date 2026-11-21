export type MeaningImage = { title:string; credit:string; page:string; thumb:string };
type WikiFile = { title:string; imageinfo?: { thumburl?:string; descriptionurl?:string; extmetadata?:Record<string,{value:string}> }[] };
type Article = {title:string; pageimage?:string; pageprops?:{disambiguation?:string}; images?:{title:string}[]; missing?:boolean};
const memory = new Map<string, MeaningImage[]>();
async function wiki<T>(host:string, params:Record<string,string>, signal:AbortSignal) {
  const query = new URLSearchParams({action:"query",format:"json",formatversion:"2",origin:"*",...params});
  const response = await fetch("https://"+host+"/w/api.php?"+query,{signal,credentials:"omit",referrerPolicy:"no-referrer"});
  if (!response.ok) throw Error("Image lookup unavailable");
  const result = await response.json();
  return (result.query?.pages ?? []) as T[];
}
function plain(value = "") {
  const template = document.createElement("template");
  template.innerHTML = value;
  return (template.content.textContent || "").replace(/\s+/g," ").trim();
}
export async function lookupMeaningImages(topic:string, signal:AbortSignal):Promise<MeaningImage[]> {
  const key = topic.trim().toLowerCase();
  if (!key || key.length > 80) return [];
  const cached = memory.get(key);
  if (cached) return cached;
  const props = {prop:"pageimages|images|pageprops",piprop:"name",imlimit:"50",redirects:"1"};
  let [page] = await wiki<Article>("en.wikipedia.org",{...props,titles:topic},signal);
  if ((!page || page.missing) && !signal.aborted) {
    [page] = await wiki<Article>("en.wikipedia.org",{...props,generator:"search",gsrsearch:topic,gsrlimit:"1",gsrnamespace:"0"},signal);
  }
  if (!page || page.pageprops?.disambiguation !== undefined) return [];
  const lead = page.pageimage && "File:"+page.pageimage;
  const terms = page.title.toLowerCase().split(/[\s()]+/).filter(w=>w.length>2);
  const descriptive = (page.images || []).map(x=>x.title).filter(title=>
    /\.(png|jpe?g|webp|svg)$/i.test(title) && !/logo|wikimedia|wikidata|\bflag\b|\bsymbol\b|icon|pencil|ambox|portal|edit.clear|question.book|featured.svg/i.test(title)
    && terms.some(word=>title.toLowerCase().includes(word)));
  const names = [...new Set([...(lead ? [lead] : []),...descriptive])].slice(0,12);
  if (!names.length) return [];
  const rows = await wiki<WikiFile>("commons.wikimedia.org",{titles:names.join("|"),prop:"imageinfo",
    iiprop:"url|extmetadata",iiurlwidth:"500",iiextmetadatafilter:"Artist|LicenseShortName|Attribution|ObjectName"},signal);
  const images:MeaningImage[] = [];
  for (const name of names) {
    const info = rows.find(row=>row.title.replaceAll("_"," ") === name.replaceAll("_"," "))?.imageinfo?.[0];
    const meta=info?.extmetadata;
    if (!info?.thumburl || !/^https:\/\/(upload|thumb)\.wikimedia\.org\//i.test(info.thumburl) || !info.descriptionurl?.startsWith("https://commons.wikimedia.org/wiki/File:") || !meta) continue;
    const license = plain(meta.LicenseShortName?.value);
    if (!/^(public domain|cc0|cc (by|by-sa)( [\d.]+)?)$/i.test(license)) continue;
    const creator = plain(meta.Attribution?.value || meta.Artist?.value);
    if (!creator && /^cc by/i.test(license)) continue;
    const title = name.slice(5).replace(/\.[^.]+$/,"").replaceAll("_"," ");
    images.push({title,thumb:info.thumburl,page:info.descriptionurl,credit:[creator.slice(0,1500),license].filter(Boolean).join(" · ")});
    if (images.length===4) break;
  }
  if (memory.size>=100) memory.delete(memory.keys().next().value!);
  memory.set(key,images);
  return images;
}
