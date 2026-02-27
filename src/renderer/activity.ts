export {};

type ActivityApi = {
  activity: {
    listEvents: (limit: number) => Promise<
      Array<{
        id: number;
        sessionId: string;
        requestId: string | null;
        tsMs: number;
        level: "info" | "warn" | "error";
        type: string;
        message: string;
        payloadJson: string | null;
      }>
    >;
    onUpdated: (listener: () => void) => () => void;
  };
};

const appApi = (window as any).orbsidian as ActivityApi;

const refreshButton = document.getElementById("refreshButton") as HTMLButtonElement;
const rows = document.getElementById("eventRows") as HTMLTableSectionElement;

function time(tsMs: number): string {
  return new Date(tsMs).toLocaleString();
}

async function refresh(): Promise<void> {
  const events = await appApi.activity.listEvents(500);
  rows.innerHTML = "";

  if (events.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "muted";
    td.textContent = "No events yet.";
    tr.appendChild(td);
    rows.appendChild(tr);
    return;
  }

  for (const event of events) {
    const tr = document.createElement("tr");

    const timeCell = document.createElement("td");
    timeCell.textContent = time(event.tsMs);

    const levelCell = document.createElement("td");
    levelCell.textContent = event.level;
    levelCell.className = `level-${event.level}`;

    const typeCell = document.createElement("td");
    typeCell.textContent = event.type;

    const messageCell = document.createElement("td");
    messageCell.textContent = event.message;
    if (event.payloadJson) {
      messageCell.title = event.payloadJson;
    }

    tr.append(timeCell, levelCell, typeCell, messageCell);
    rows.appendChild(tr);
  }
}

refreshButton.addEventListener("click", () => {
  void refresh();
});

appApi.activity.onUpdated(() => {
  void refresh();
});

void refresh();
