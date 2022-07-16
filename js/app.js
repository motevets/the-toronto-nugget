var Client = {};

// NOTE THAT web crypto libraries aren't available in local network,
// non-localhost environments. For the sake of future debugging.

Client.DEV = false;

// Rather than create them every time I need them:
Client.encoder = new TextEncoder();
Client.parser = new DOMParser();

Client.sources = {};
Client.boardTimestamps = {};
Client.hypocorisms = {};

Client.DEV_ACCELERATOR = 1.0; // 1.0
Client.BASE_TIMEOUT_SECONDS = 60*5*Client.DEV_ACCELERATOR;
Client.MAX_TIMEOUT_SECONDS = 60*60*24*Client.DEV_ACCELERATOR;

Client.KEY_REGEX = /\/([0-9a-f]{64})\/?$/;
Client.SPRING_URL_REGEX = /http.+\/[0-9a-f]{64}\/?/;

Client.FEED_PROXY = "https://us-west1-spring-83.cloudfunctions.net/feed-proxy";


Client.setup = async function() {
  // -- Global element handles --

  Client.main = document.querySelector("main");

  Client.previewModal = document.querySelector("preview-modal");
  Client.boardPreview = document.querySelector("board-preview");
  Client.itemGrid = document.querySelector("item-grid");

  // -- Intersection observer --

  const intOptions = {
    threshold: 0.8
  }

  Client.observer = new IntersectionObserver(Client.intersect, intOptions);


  // When you're viewing the board previee and you click outside, it closes
  Client.previewModal.addEventListener("mousedown", (e) => {
    if (e.target.tagName.toLowerCase() == "preview-modal") {
      Client.hideBoardPreview();
    }
  });

  // just copying and pasting for now! Sorryyyy
  Client.previewModal.addEventListener("touchstart", (e) => {
    if (e.target.tagName.toLowerCase() == "preview-modal") {
      Client.hideBoardPreview();
    }
  });

  // -- Link click handling, which does several important things

  // https://stackoverflow.com/questions/12235585/is-there-a-way-to-open-all-a-href-links-on-a-page-in-new-windows
  document.body.addEventListener("click", (e) => {
    // composedPath, weeeird
    // https://pm.dartus.fr/blog/a-complete-guide-on-shadow-dom-and-event-propagation/
    const clickedElement = e.composedPath()[0];
    if (clickedElement.nodeName.toUpperCase() === "A") {
      clickedElement.target = "_blank";
      if (clickedElement.href.match(Client.SPRING_URL_REGEX)) {
        Client.previewBoardAtURL(clickedElement.href);
        e.preventDefault();
      }
    }
  }, true);

  await Client.loadBoardsIndex();
  Client.reloadItemGrid(true);
  // No need to do this, because it happens automatically with reloadItemGrid:
  // Client.checkSources(true); // force;
  setInterval(Client.checkSources, 1000*60);
}

document.addEventListener("DOMContentLoaded", (e) => {
  Client.setup();
});

Client.lastModifiedInHTML = async function(html) {
  let boardElement = await Client.parser.parseFromString(html, "text/html");
  let timeElement = boardElement.querySelector("time");
  let timestamp = timeElement.getAttribute("datetime");
  if (timeElement && timestamp) {
    // TODO: validate this actually an ISO 8601 timestamp! duh!
    return new Date(timestamp);
  } else {
    return null;
  }
}

// -- Intersection, "un-highlighting" fresh items --

Client.intersect = function(entries, observer) {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.remove("refreshed");
    } else {
      // not a dang thing
    }
  });
}

// -- Servers --

Client.getHomeServer = function() {
  return Client.DEV ? "http://localhost:8787/" : "https://spring83.kindrobot.ca/";
}

// -- Preview a board, FUN --

Client.previewBoardAtURL = async function(url) {
  // This definitely has a lot of duplicated code from other functions
  // Alas

  const keyMatch = url.match(Client.KEY_REGEX);
  if (keyMatch === null) {
    console.log("Not a Spring 83 URL!");
    return;
  }

  const key = keyMatch[1];

  let template = document.querySelector("template#board-preview-template");
  let boardDisplay = template.content.cloneNode(true);
  // I find it confusing that I still have to query into the board-item here:
  let boardItem = boardDisplay.querySelector("board-item");

  let boardArea = boardItem.querySelector("board-area");

  let boardURLDisplay = boardItem.querySelector("input");
  boardURLDisplay.value = url;
  boardURLDisplay.addEventListener("click", (e) => {
    e.target.setSelectionRange(0, e.target.value.length);
  });

  // CONJURE THE SHADOW DOM, RAHHH
  let boardContent = boardItem.querySelector("board-content");
  boardContent.attachShadow({mode: "open"});

  let response;

  try {
    response = await fetch(url, {
      method: "GET",
      mode: "cors"
    });
  } catch (e) {
    console.log("Error with fetch; server not found? TODO: document.");
    console.log("TODO handle this better.")
    return;
  }

  const signature = response.headers.get("Spring-Signature");
  if (!signature) {
    console.log("Server didn't sign the response.");
    return false;
  }

  const board = await response.text();

  // https://stackoverflow.com/questions/6965107/converting-between-strings-and-arraybuffers
  const boardForVerification = Client.encoder.encode(board);

  const verified = await nobleEd25519.verify(signature, boardForVerification, key);

  if (verified) {
    console.log("Signature verified, how nice.");
  } else {
    console.log("Signature is not correct; dropping");
    return false;
    // TODO mark server as untrustworthy
  }

  boardContent.shadowRoot.innerHTML = DEFAULT_BOARD_CSS + board;

  Client.boardPreview.innerHTML = "";
  Client.boardPreview.append(boardItem);
  Client.showBoardPreview();
}

// -- Board preview modal behavior --

Client.showBoardPreview = function() {
  Client.previewModal.style.display = "flex";
  Client.showingBoardPreview = true;
}

Client.hideBoardPreview = function() {
  Client.previewModal.style.display = "none";
  Client.showingBoardPreview = false;
}

// -- Here's the beating heart --

Client.loadBoardsIndex = async function() {

  let newSources = {};
  let index = 0;

  // reset pet names
  Client.hypocorisms = {};

  const response = await fetch(Client.getHomeServer() + 'index.json');
  const boardList = await response.json();

  if (boardList.adminBoard.key) {
    Client.hypocorisms[boardList.adminBoard.key] = "Admin Board";
    newSources[boardList.adminBoard.key] = {
      type: "board",
      url: Client.getHomeServer() + boardList.adminBoard.key,
      index: -1, // always first
      lastChecked: -1,
      lastHeardFrom: -1,
      timeout: 0
    };
  }

  boardList.boards.forEach(board => {
    newSources[board.key] = {
        type: "board",
        url: Client.getHomeServer() + board.key,
        index: index++, // is this too cryptic/tricky? I like it
        lastChecked: -1,
        lastHeardFrom: -1,
        timeout: Math.round(Client.BASE_TIMEOUT_SECONDS * Math.random())
    };
  });
  Client.sources = newSources;
}

// -- Board handling stuff --

Client.renderFullBoardHTML = async function() {
  let t = performance.now();
  const timestamp = new Date().toISOString().slice(0, 19) + "Z";
  const boardMarkdown = Client.editor.getValue();
  const boardHTML = marked.parse(boardMarkdown);
  const timeElement = `<time datetime="${timestamp}"></time>\n`;
  console.log(`rendered full board HTML in ${(performance.now() - t).toPrecision(2)} seconds`);
  return timeElement + boardHTML;
}

Client.setBoardHTML = function(key, board) {
  localStorage.setItem(key, board);
}

Client.getBoardHTML = function(key) {
  return localStorage.getItem(key);
}

// -- View source --

Client.showViewSource = function(key) {
  const id = `board-${key}`;
  let viewSource = document.querySelector(`#${id} view-source`);
  viewSource.style.display = "block";
}

Client.hideViewSource = function(key) {
  const id = `board-${key}`;
  let viewSource = document.querySelector(`#${id} view-source`);
  viewSource.style.display = "none";
}

// -- Item retrieval and display --

Client.reloadItemGrid = async function(forceCheck = false) {
  const itemGrid = document.querySelector("item-grid");
  if (itemGrid) {
    itemGrid.innerHTML = "";
  }

  Object.keys(Client.sources).forEach(async (key) => {
    const source = Client.sources[key];

    if (source.type === "board") {
      Client.createBoardItem(key, forceCheck);
    }
    if (source.type === "feed") {
      Client.createFeedItem(key, forceCheck);
    }
  });
}

Client.checkSources = async function(forceCheck = false) {
  // The idea is that we run the check functions relatively often,
  // but they often return quickly, saying "nah, not yet"

  Object.keys(Client.sources).forEach(async (key) => {
    const source = Client.sources[key];
    if (source.type === "board") {
      await Client.checkBoardSource(key, forceCheck);
    }
  });
}

// -- Board sources --

Client.checkBoardSource = async function(key, forceCheck = false) {
  let source = Client.sources[key];

  if (!source) {
    console.log("tried to checkBoardSource for a key I don't know anything about:");
    console.log(key);
    return false;
  }

  if (!forceCheck && ((source.lastChecked + source.timeout) < Date.now())) {
    console.log(`Not ready to check ${key} yet.`);
    return false;
  }

  const url = source.url;
  console.log(`Checking board at URL: ${url}`);

  // TODO might be able to just check existing board HTML,
  // rather than maintain this other data structure. Fine for now though
  let ifModifiedSince = Client.boardTimestamps[key] ? Client.boardTimestamps[key] : new Date(0);

  source.lastChecked = Date.now();

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      mode: "cors",
      headers: {
        "If-Modified-Since": new Date(ifModifiedSince).toUTCString(),
        "Spring-Version": "83"
      }
    });
  } catch (e) {
    console.log("Error with board fetch; server not found?");
    console.log("Extending timeout with jittered exponential backoff.");
    source.timeout = source.timeout + Math.round(source.timeout * Math.random());
    source.timeout = Math.min(source.timeout, Client.MAX_TIMEOUT_SECONDS);
    return;
  }

  source.lastHeardFrom = Date.now();

  // jitter the timeout
  source.timeout = Client.BASE_TIMEOUT_SECONDS +
                   Math.round(Client.BASE_TIMEOUT_SECONDS * Math.random());

  if (!response) {
    console.log("Null response fell through in checkBoardSource... this shouldn't happen");
    return;
  }

  if (response.status == 304) {
    console.log("No new board available for this key.");
    return false;
  }

  if (response.status == 404) {
    console.log("No board found for this key.");
    return false;
  }

  const signature = response.headers.get("Spring-Signature");
  if (!signature) {
    console.log("Server didn't sign the response.");
    return false;
  }

  const board = await response.text();

  // https://stackoverflow.com/questions/6965107/converting-between-strings-and-arraybuffers
  const boardForVerification = Client.encoder.encode(board);

  const verified = await nobleEd25519.verify(signature, boardForVerification, key);

  if (verified) {
    console.log("Signature verified, how nice.");
  } else {
    console.log("Signature is not correct; dropping");
    return false;
    // TODO mark server as untrustworthy
  }

  // See, here I just treat the HTML as the "canonical" source of timestamps
  // It's really a muddle
  // TODO: clean up!
  const existingBoard = Client.getBoardHTML(key);
  if (existingBoard) {
    const existingTimestamp = await Client.lastModifiedInHTML(existingBoard);
    const incomingTimestamp = await Client.lastModifiedInHTML(board);

    if (existingTimestamp >= incomingTimestamp) {
      console.log("New board is older or equivalent to the one I have. Ignoring.");
      return false;
    } else {
      Client.boardTimestamps[key] = incomingTimestamp;
    }
  }

  Client.setBoardHTML(key, board);
  Client.refreshBoardItem(key);

  return true;
}

Client.createBoardItem = function(key) {
  const id = `board-${key}`;
  const index = Client.sources[key].index;

  let template = document.querySelector("template#board-template");
  let boardDisplay = template.content.cloneNode(true);
  // I find it confusing that I still have to query into the board-item here:
  let boardItem = boardDisplay.querySelector("board-item");

  boardItem.id = id;
  boardItem.style.order = `${index}`;
  boardItem.dataset.index = index;

  let boardArea = boardItem.querySelector("board-area");
  let viewSource = boardArea.querySelector("view-source");
  let viewSourceTextArea = viewSource.querySelector("textarea");

  // CONJURE THE SHADOW DOM, RAHHH
  let boardContent = boardItem.querySelector("board-content");
  boardContent.attachShadow({mode: "open"});

  const boardHTML = Client.getBoardHTML(key);
  if (boardHTML) {
    // MARK -- I am adding this little scrap of CSS here
    boardContent.shadowRoot.innerHTML = DEFAULT_BOARD_CSS + boardHTML;
    // TODO: what I'd really like to do is strip out the <time> tag here...
    viewSourceTextArea.innerHTML = boardHTML;
  }

  // In the functions below, I never actually expect the locally-bound variables like `viewSource` and `boardContent` to work inside these callbacks... but they do... and it's weird

  // Click handler to SHOW View Source
  viewSource.addEventListener("click", (e) => {
    // it's brittle!
    viewSource.style.zIndex = "1000";
    viewSourceTextArea.style.cursor = "text";
    viewSourceTextArea.classList.add("showing");
    boardContent.style.cursor = "pointer";
  });

  // Click handler to HIDE View Source
  boardContent.addEventListener("click", (e) => {
    // yep, pretty brittle!
    if (viewSource.style.zIndex == "1000") {
      viewSource.style.zIndex = "10";
      viewSourceTextArea.style.cursor = "pointer";
      viewSourceTextArea.classList.remove("showing");
      boardContent.style.cursor = "default";
    }
  });

  if (Client.hypocorisms[key]) {
    boardItem.querySelector("board-label").innerHTML = Client.hypocorisms[key];
  }

  Client.itemGrid.append(boardItem);
  Client.observer.observe(boardItem);

  Client.checkBoardSource(key, true); // force

  return boardItem;
}

Client.refreshBoardItem = function(key) {
  let boardHTML = Client.getBoardHTML(key);

  if (boardHTML === null) {
    boardHTML = `
    <style>
      div {
        display: flex;
        justify-content: center;
        align-items: center;
        width: 100%;
        height: 100%;
      }

      p {
        text-align: center;
        width: 50%;
      }
    </style>
    <div><p>No board found for key ${key.slice(0, 12)}&hellip;</p></div>
    `.trim();
  }

  let boardItem = document.querySelector(`#board-${key}`);

  boardItem.classList.add("refreshed");

  if (boardItem == null) {
    boardItem = Client.createBoardItem(key);
  }

  if (Client.hypocorisms[key]) {
    boardItem.querySelector("board-label").innerHTML = Client.hypocorisms[key];
  }

  let boardContent = boardItem.querySelector("board-content");
  let viewSourceContent = boardItem.querySelector("view-source textarea");

  // MARK -- I am adding the extra CSS here
  boardContent.shadowRoot.innerHTML = DEFAULT_BOARD_CSS + boardHTML;
  viewSourceContent.innerHTML = boardHTML;
}

DEFAULT_BOARD_CSS = `
<style>
  :host {
    background-color: var(--c-paper-bright);
    box-sizing: border-box;
    padding: 2rem;
  }
  time { display: none; }
  p, h1, h2, h3, h4, h5 { margin: 0 0 2rem 0; }
</style>
`.trim();

