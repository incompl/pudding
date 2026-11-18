import { listStations, type Station } from "./stations.ts";

const app = document.getElementById("app")!;

function renderStations(stations: Station[]) {
  const list = document.createElement("ul");
  list.className = "stations";
  for (const station of stations) {
    const row = document.createElement("li");
    if (station.image) {
      const img = document.createElement("img");
      img.src = station.image;
      img.alt = "";
      row.append(img);
    }
    const name = document.createElement("span");
    name.textContent = station.name;
    row.append(name);
    list.append(row);
  }
  app.replaceChildren(list);
}

listStations().then(renderStations, (err) => {
  app.textContent = String(err);
});
