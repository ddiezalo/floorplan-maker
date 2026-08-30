const SVG_NS = "http://www.w3.org/2000/svg";
const STORAGE_KEY = "room-shape-reconstructor-v2";
const PROJECT_SCHEMA = "room-shape-reconstructor-project";
const PROJECT_VERSION = 1;

const directionChoices = [
    ["up-left", "↖"], ["up", "↑"], ["up-right", "↗"], ["right", "→"],
    ["down-right", "↘"], ["down", "↓"], ["down-left", "↙"], ["left", "←"],
];

const state = {
    wallCount: 4,
    walls: [],
    diagonals: [],
    rightAngles: [],
    direction: "right",
    orientation: "cw",
    roomName: "",
    rooms: [],
    editingRoomId: null,
    mode: "room",
    combineDraft: [],
    combinedLayout: null,
    pyodide: null,
    solverReady: false,
    draggedRoomId: null,
};

const $ = selector => document.querySelector(selector);
const roomsList = $("#roomsList");
const wallsList = $("#wallsList");
const diagonalsList = $("#diagonalsList");
const anglesList = $("#anglesList");
const connectionsList = $("#connectionsList");
const generateButton = $("#generateButton");
const combinedGraph = $("#combinedGraph");
const helpDialog = $("#helpDialog");
const exportProjectButton = $("#exportProjectButton");
const importProjectButton = $("#importProjectButton");
const importProjectInput = $("#importProjectInput");

function uid() {
    if (window.crypto?.randomUUID) return crypto.randomUUID();
    return `room-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function deepCopy(value) {
    return JSON.parse(JSON.stringify(value));
}

function defaultWall() {
    return { length: "", tolerance: 0.01 };
}

function defaultDiagonal() {
    return { from: "", to: "", length: "", tolerance: 0.02 };
}

function defaultRightAngle() {
    return { corner: "" };
}

function defaultRoomForm() {
    return {
        wallCount: 4,
        walls: Array.from({ length: 4 }, defaultWall),
        diagonals: [defaultDiagonal()],
        rightAngles: [defaultRightAngle()],
        direction: "right",
        orientation: "cw",
        roomName: "",
    };
}

function roomById(roomId) {
    return state.rooms.find(room => room.id === roomId);
}

function invalidateCombinedResult() {
    state.combinedLayout = null;
    $("#combinedResultCard").classList.add("hidden");
}

function pythonErrorMessage(error) {
    return String(error).replace(/^PythonError:\s*/, "").split("\n").slice(-2).join(" ");
}

function resetRoomForm({ keepMessage = false } = {}) {
    if (!keepMessage) clearMessages();
    applyFormSnapshot(defaultRoomForm());
}

function loadRooms() {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.warn("Could not read saved rooms", error);
        return [];
    }
}

function persistRooms() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.rooms));
}

function hasMeaningfulDraftData(form = currentFormSnapshot()) {
    return Boolean(
        String(form.roomName || "").trim()
        || form.walls?.some(wall => String(wall.length ?? "").trim() !== "")
        || form.diagonals?.some(diagonal => diagonal.from !== "" || diagonal.to !== "" || String(diagonal.length ?? "").trim() !== "")
        || form.rightAngles?.some(angle => angle.corner !== "")
    );
}

function updateProjectControls() {
    exportProjectButton.disabled = !(state.rooms.length || hasMeaningfulDraftData());
}

function initializeWallCountSelect() {
    const select = $("#wallCount");
    select.innerHTML = "";
    for (let n = 3; n <= 20; n++) {
        const option = document.createElement("option");
        option.value = String(n);
        option.textContent = String(n);
        select.appendChild(option);
    }
    select.value = String(state.wallCount);
}

function toleranceSelect(value, recommended) {
    const select = document.createElement("select");
    for (let pct = 1; pct <= 5; pct++) {
        const option = document.createElement("option");
        option.value = String(pct / 100);
        option.textContent = `${pct}%${pct === recommended ? " (recommended)" : ""}`;
        if (Math.abs(Number(value) - pct / 100) < 1e-9) option.selected = true;
        select.appendChild(option);
    }
    return select;
}

function numberInput(value, placeholder = "cm") {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0.01";
    input.step = "0.01";
    input.inputMode = "decimal";
    input.placeholder = placeholder;
    input.value = value ?? "";
    return input;
}

function actionButtons(onRemove, onAdd) {
    const actions = document.createElement("div");
    actions.className = "row-actions";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button remove";
    remove.title = "Remove row";
    remove.setAttribute("aria-label", "Remove row");
    remove.textContent = "×";
    remove.addEventListener("click", onRemove);

    const add = document.createElement("button");
    add.type = "button";
    add.className = "icon-button";
    add.title = "Add row below";
    add.setAttribute("aria-label", "Add row below");
    add.textContent = "+";
    add.addEventListener("click", onAdd);

    actions.append(remove, add);
    return actions;
}

function cornerSelect(value, placeholder = "Corner") {
    const select = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = placeholder;
    select.appendChild(blank);

    for (let corner = 1; corner <= state.wallCount; corner++) {
        const option = document.createElement("option");
        option.value = String(corner);
        option.textContent = `Corner ${corner}`;
        if (String(value) === String(corner)) option.selected = true;
        select.appendChild(option);
    }
    return select;
}

function wallLabel(index, n) {
    return `Corner ${index + 1} <span class="arrow">→</span> Corner ${((index + 1) % n) + 1}`;
}

function resizeWalls(newCount) {
    const current = state.walls.slice(0, newCount);
    while (current.length < newCount) current.push(defaultWall());
    state.wallCount = newCount;
    state.walls = current;

    state.diagonals.forEach(d => {
        if (d.from !== "" && Number(d.from) > newCount) d.from = "";
        if (d.to !== "" && Number(d.to) > newCount) d.to = "";
    });
    state.rightAngles.forEach(a => {
        if (a.corner !== "" && Number(a.corner) > newCount) a.corner = "";
    });
    renderAllInputs();
}

function renderWalls() {
    wallsList.innerHTML = "";

    state.walls.forEach((wall, index) => {
        const row = document.createElement("div");
        row.className = "measure-row wall-row";

        const label = document.createElement("span");
        label.className = "wall-label";
        label.innerHTML = wallLabel(index, state.wallCount);

        const length = numberInput(wall.length);
        length.addEventListener("input", () => wall.length = length.value);

        let direction;
        if (index === 0) {
            direction = document.createElement("select");
            direction.className = "direction-select";
            direction.setAttribute("aria-label", "First wall direction");

            directionChoices.forEach(([key, label]) => {
                const option = document.createElement("option");
                option.value = key;
                option.textContent = label;
                if (state.direction === key) option.selected = true;
                direction.appendChild(option);
            });

            direction.addEventListener("change", () => {
                state.direction = direction.value;
            });
        } else {
            direction = document.createElement("span");
            direction.className = "direction-placeholder";
            direction.textContent = "—";
        }

        const tolerance = toleranceSelect(wall.tolerance, 1);
        tolerance.addEventListener("change", () => wall.tolerance = Number(tolerance.value));

        row.append(label, length, direction, tolerance);
        wallsList.appendChild(row);
    });
}

function renderDiagonals() {
    diagonalsList.innerHTML = "";

    state.diagonals.forEach((diagonal, index) => {
        const row = document.createElement("div");
        row.className = "measure-row diagonal-row";

        const from = cornerSelect(diagonal.from, "From corner");
        from.addEventListener("change", () => diagonal.from = from.value);

        const to = cornerSelect(diagonal.to, "To corner");
        to.addEventListener("change", () => diagonal.to = to.value);

        const length = numberInput(diagonal.length);
        length.addEventListener("input", () => diagonal.length = length.value);

        const tolerance = toleranceSelect(diagonal.tolerance, 2);
        tolerance.addEventListener("change", () => diagonal.tolerance = Number(tolerance.value));

        const actions = actionButtons(
            () => {
                if (state.diagonals.length === 1) state.diagonals[0] = defaultDiagonal();
                else state.diagonals.splice(index, 1);
                renderDiagonals();
                updateProjectControls();
            },
            () => {
                state.diagonals.splice(index + 1, 0, defaultDiagonal());
                renderDiagonals();
                updateProjectControls();
            },
        );

        row.append(from, to, length, tolerance, actions);
        diagonalsList.appendChild(row);
    });
}

function renderAngles() {
    anglesList.innerHTML = "";

    state.rightAngles.forEach((angle, index) => {
        const row = document.createElement("div");
        row.className = "measure-row angle-row";

        const select = cornerSelect(angle.corner, "Select corner");
        select.addEventListener("change", () => angle.corner = select.value);

        const spacer = document.createElement("span");
        const actions = actionButtons(
            () => {
                if (state.rightAngles.length === 1) state.rightAngles[0] = defaultRightAngle();
                else state.rightAngles.splice(index, 1);
                renderAngles();
                updateProjectControls();
            },
            () => {
                state.rightAngles.splice(index + 1, 0, defaultRightAngle());
                renderAngles();
                updateProjectControls();
            },
        );

        row.append(select, spacer, actions);
        anglesList.appendChild(row);
    });
}

function renderAllInputs() {
    $("#wallCount").value = String(state.wallCount);
    $("#roomName").value = state.roomName;
    renderWalls();
    renderDiagonals();
    renderAngles();
    updateProjectControls();
}

function showMessage(element, message) {
    element.textContent = message;
    element.classList.remove("hidden");
}

function clearMessages() {
    [$("#formError"), $("#formSuccess"), $("#combineError")].forEach(el => {
        el.textContent = "";
        el.classList.add("hidden");
    });
}

function buildPayloadFromForm(form) {
    const wallCount = Number(form.wallCount);
    if (!Number.isInteger(wallCount) || wallCount < 3 || wallCount > 20) {
        throw new Error("The project contains an invalid number of walls.");
    }
    if (!Array.isArray(form.walls) || form.walls.length !== wallCount) {
        throw new Error("The number of wall measurements does not match the selected wall count.");
    }

    const walls = form.walls.map((wall, index) => {
        const length = Number(wall.length);
        if (!Number.isFinite(length) || length <= 0) {
            throw new Error(`Enter a valid positive length for Wall ${index + 1}.`);
        }
        const tolerance = Number(wall.tolerance);
        if (!Number.isFinite(tolerance) || tolerance <= 0) {
            throw new Error(`Wall ${index + 1} has an invalid tolerance.`);
        }
        return { length, tolerance };
    });

    const diagonals = [];
    for (const [index, diagonal] of (form.diagonals || []).entries()) {
        const anyValue = diagonal.from !== "" || diagonal.to !== "" || diagonal.length !== "";
        if (!anyValue) continue;
        if (diagonal.from === "" || diagonal.to === "" || diagonal.length === "") {
            throw new Error(`Complete all fields for diagonal ${index + 1}, or remove that row.`);
        }

        const fromUi = Number(diagonal.from);
        const toUi = Number(diagonal.to);
        const length = Number(diagonal.length);
        const tolerance = Number(diagonal.tolerance);
        if (!Number.isFinite(length) || length <= 0) throw new Error(`Enter a valid positive length for diagonal ${index + 1}.`);
        if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error(`Diagonal ${index + 1} has an invalid tolerance.`);
        if (fromUi === toUi) throw new Error(`Diagonal ${index + 1} must join two different corners.`);
        if (fromUi < 1 || fromUi > wallCount || toUi < 1 || toUi > wallCount) {
            throw new Error(`Diagonal ${index + 1} refers to a corner outside the room.`);
        }

        const from = fromUi - 1;
        const to = toUi - 1;
        const a = Math.min(from, to);
        const b = Math.max(from, to);
        if (b - a === 1 || (a === 0 && b === wallCount - 1)) {
            throw new Error(`Corner ${a + 1} to Corner ${b + 1} is a wall, not a diagonal.`);
        }
        diagonals.push({ from, to, length, tolerance });
    }

    const rightAngles = [...new Set(
        (form.rightAngles || [])
            .filter(angle => angle.corner !== "")
            .map(angle => Number(angle.corner) - 1)
    )];
    if (rightAngles.some(index => !Number.isInteger(index) || index < 0 || index >= wallCount)) {
        throw new Error("A confident right angle refers to a corner outside the room.");
    }

    const direction = directionChoices.some(([key]) => key === form.direction) ? form.direction : "right";
    const orientation = form.orientation === "ccw" ? "ccw" : "cw";

    return {
        walls,
        diagonals,
        right_angles: rightAngles,
        direction,
        orientation,
    };
}

function buildPayload() {
    return buildPayloadFromForm(currentFormSnapshot());
}

function currentFormSnapshot() {
    return {
        wallCount: state.wallCount,
        walls: deepCopy(state.walls),
        diagonals: deepCopy(state.diagonals),
        rightAngles: deepCopy(state.rightAngles),
        direction: state.direction,
        orientation: state.orientation,
        roomName: state.roomName,
    };
}

function normalizeImportedForm(rawForm, fallbackName = "") {
    if (!rawForm || typeof rawForm !== "object") throw new Error("A room is missing its measurement form.");
    const inferredCount = Array.isArray(rawForm.walls) ? rawForm.walls.length : 0;
    const wallCount = Number(rawForm.wallCount || inferredCount);
    if (!Number.isInteger(wallCount) || wallCount < 3 || wallCount > 20) {
        throw new Error("A room contains an invalid number of walls.");
    }

    const sourceWalls = Array.isArray(rawForm.walls) ? rawForm.walls : [];
    if (sourceWalls.length !== wallCount) throw new Error("A room's wall count does not match its wall measurements.");

    return {
        wallCount,
        walls: sourceWalls.map(wall => ({
            length: wall?.length ?? "",
            tolerance: Number(wall?.tolerance ?? 0.01),
        })),
        diagonals: Array.isArray(rawForm.diagonals) && rawForm.diagonals.length
            ? rawForm.diagonals.map(diagonal => ({
                from: diagonal?.from ?? "",
                to: diagonal?.to ?? "",
                length: diagonal?.length ?? "",
                tolerance: Number(diagonal?.tolerance ?? 0.02),
            }))
            : [defaultDiagonal()],
        rightAngles: Array.isArray(rawForm.rightAngles) && rawForm.rightAngles.length
            ? rawForm.rightAngles.map(angle => ({ corner: angle?.corner ?? "" }))
            : [defaultRightAngle()],
        direction: directionChoices.some(([key]) => key === rawForm.direction) ? rawForm.direction : "right",
        orientation: rawForm.orientation === "ccw" ? "ccw" : "cw",
        roomName: String(rawForm.roomName || fallbackName || ""),
    };
}

function applyFormSnapshot(form, editingRoomId = null) {
    state.wallCount = form.wallCount;
    state.walls = deepCopy(form.walls);
    state.diagonals = deepCopy(form.diagonals.length ? form.diagonals : [defaultDiagonal()]);
    state.rightAngles = deepCopy(form.rightAngles.length ? form.rightAngles : [defaultRightAngle()]);
    state.direction = form.direction;
    state.orientation = form.orientation;
    state.roomName = form.roomName || "";
    state.editingRoomId = editingRoomId && state.rooms.some(room => room.id === editingRoomId) ? editingRoomId : null;

    document.querySelector(`input[name="orientation"][value="${state.orientation}"]`).checked = true;
    if (state.editingRoomId) {
        const room = roomById(state.editingRoomId);
        $("#editingText").textContent = `Editing ${room?.name || state.roomName}`;
        $("#editingBanner").classList.remove("hidden");
    } else {
        $("#editingBanner").classList.add("hidden");
    }
    renderAllInputs();
}

function projectSnapshot() {
    return {
        schema: PROJECT_SCHEMA,
        version: PROJECT_VERSION,
        exportedAt: new Date().toISOString(),
        rooms: state.rooms.map(room => ({
            id: room.id,
            name: room.name,
            form: deepCopy(room.form),
        })),
        roomDraft: currentFormSnapshot(),
        editingRoomId: state.editingRoomId,
        combineDraft: deepCopy(state.combineDraft),
    };
}

function exportProject() {
    if (exportProjectButton.disabled) return;
    const project = projectSnapshot();
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `room-shape-project-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

async function importProject(file) {
    if (!file) return;
    if (!state.solverReady) throw new Error("The solver is still loading. Try importing again in a moment.");

    const parsed = JSON.parse(await file.text());
    if (!parsed || parsed.schema !== PROJECT_SCHEMA) throw new Error("This file is not a Room Shape Reconstructor project.");
    if (Number(parsed.version) !== PROJECT_VERSION) throw new Error(`Project version ${parsed.version} is not supported by this version of the tool.`);
    if (!Array.isArray(parsed.rooms)) throw new Error("The project file does not contain a valid rooms list.");

    const importedRooms = [];
    const usedIds = new Set();
    for (let index = 0; index < parsed.rooms.length; index++) {
        const sourceRoom = parsed.rooms[index] || {};
        const form = normalizeImportedForm(sourceRoom.form, sourceRoom.name);
        const name = String(sourceRoom.name || form.roomName || `Room ${index + 1}`);
        form.roomName = name;
        let id = String(sourceRoom.id || uid());
        if (usedIds.has(id)) id = uid();
        usedIds.add(id);

        let result;
        try {
            result = await solvePayload(buildPayloadFromForm(form));
        } catch (error) {
            throw new Error(`${name} could not be regenerated from the imported measurements: ${pythonErrorMessage(error)}`);
        }
        importedRooms.push({
            id,
            name,
            form: { ...form, roomName: name },
            result,
        });
    }

    const importedDraft = normalizeImportedForm(parsed.roomDraft || defaultRoomForm());

    state.rooms = importedRooms;
    state.combineDraft = Array.isArray(parsed.combineDraft) ? deepCopy(parsed.combineDraft) : [];
    state.mode = "room";
    persistRooms();
    invalidateCombinedResult();
    normalizeCombineDraft();

    const importedEditingId = importedRooms.some(room => room.id === parsed.editingRoomId) ? parsed.editingRoomId : null;
    applyFormSnapshot(importedDraft, importedEditingId);
    showRoomEditor();
    clearMessages();
    showMessage($("#formSuccess"), `${importedRooms.length} room${importedRooms.length === 1 ? "" : "s"} imported and regenerated.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function loadRoomForEdit(roomId) {
    const room = roomById(roomId);
    if (!room) return;
    const form = deepCopy(room.form);
    form.roomName ||= room.name;

    clearMessages();
    applyFormSnapshot(form, room.id);
    showRoomEditor();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

async function initializeSolver() {
    const status = $("#solverStatus");
    try {
        state.pyodide = await loadPyodide({
            indexURL: "https://cdn.jsdelivr.net/pyodide/v314.0.4/full/",
        });
        await state.pyodide.loadPackage(["numpy", "scipy"]);
        const response = await fetch("solver.py");
        if (!response.ok) throw new Error("Could not load solver.py");
        await state.pyodide.runPythonAsync(await response.text());
        state.solverReady = true;
        status.textContent = "Solver ready";
        status.className = "status-pill ready";
        generateButton.disabled = false;
        importProjectButton.disabled = false;
    } catch (error) {
        console.error(error);
        status.textContent = "Solver failed to load";
        status.className = "status-pill failed";
        showMessage($("#formError"), "The numerical solver could not be loaded. Open the page through a web server or GitHub Pages and check the internet connection.");
    }
}

async function solvePayload(payload) {
    state.pyodide.globals.set("ui_payload_json", JSON.stringify(payload));
    const resultJson = await state.pyodide.runPythonAsync("solve_from_json(ui_payload_json)");
    return JSON.parse(resultJson);
}

async function generateRoom() {
    clearMessages();
    if (!state.solverReady) {
        showMessage($("#formError"), "The solver is still loading.");
        return;
    }

    state.roomName = $("#roomName").value.trim();
    let payload;
    try {
        payload = buildPayload();
    } catch (error) {
        showMessage($("#formError"), error.message);
        return;
    }

    generateButton.disabled = true;
    generateButton.textContent = "Generating…";

    try {
        const result = await solvePayload(payload);
        const editingIndex = state.editingRoomId ? state.rooms.findIndex(r => r.id === state.editingRoomId) : -1;
        const defaultName = editingIndex >= 0 ? state.rooms[editingIndex].name : `Room ${state.rooms.length + 1}`;
        const name = state.roomName || defaultName;
        const room = {
            id: editingIndex >= 0 ? state.rooms[editingIndex].id : uid(),
            name,
            form: { ...currentFormSnapshot(), roomName: name },
            result,
        };

        if (editingIndex >= 0) state.rooms[editingIndex] = room;
        else state.rooms.push(room);

        persistRooms();
        invalidateCombinedResult();
        renderSidebar();
        resetRoomForm({ keepMessage: true });
        showMessage($("#formSuccess"), editingIndex >= 0 ? `${name} was updated.` : `${name} was added to your saved rooms.`);
    } catch (error) {
        console.error(error);
        const message = pythonErrorMessage(error);
        showMessage($("#formError"), message || "The shape could not be generated from these constraints.");
    } finally {
        generateButton.disabled = false;
        generateButton.textContent = "Generate shape";
    }
}

// =============================================================================
// SVG DRAWING
// =============================================================================

function svgElement(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    return el;
}

function boundsForVertices(vertices, padding = 50) {
    const xs = vertices.map(p => p[0]);
    const ys = vertices.map(p => p[1]);
    return {
        xMin: Math.min(...xs) - padding,
        xMax: Math.max(...xs) + padding,
        yMin: Math.min(...ys) - padding,
        yMax: Math.max(...ys) + padding,
    };
}

function boundsForMany(vertexGroups, padding = 50) {
    return boundsForVertices(vertexGroups.flat(), padding);
}

function worldMapper(bounds) {
    return point => [point[0] - bounds.xMin, bounds.yMax - point[1]];
}

function drawingMetrics(bounds, mini = false) {
    const width = bounds.xMax - bounds.xMin;
    const height = bounds.yMax - bounds.yMin;
    const geometricMean = Math.sqrt(Math.max(width * height, 1));
    const wallWidth = geometricMean * (mini ? 0.008 : 0.0042);
    const fontSize = geometricMean * 0.01;
    return {
        wallWidth,
        diagonalWidth: wallWidth * 0.68,
        gridWidth: wallWidth * 0.22,
        vertexRadius: wallWidth * 1.15,
        highlightWidth: wallWidth * 2.0,
        fontSize,
        angleFontSize: fontSize * 0.78,
        sideOffset: fontSize * 0.45,
        angleOffset: fontSize * 1.5,
    };
}

function readableAngle(a, b) {
    let angle = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    if (angle > 90) angle -= 180;
    else if (angle < -90) angle += 180;
    return angle;
}

function formatAngle(value) {
    const rounded = Math.round(value * 10) / 10;
    return Math.abs(rounded - Math.round(rounded)) < 1e-9 ? `${Math.round(rounded)}º` : `${rounded.toFixed(1)}º`;
}

function addSvgText(svg, x, y, text, options = {}) {
    const haloColor = options.haloColor === undefined ? "white" : options.haloColor;
    const attrs = {
        x, y,
        "font-size": options.fontSize,
        fill: options.fill || "#111827",
        "fill-opacity": options.opacity ?? 1,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-family": "Inter, Arial, sans-serif",
        "font-weight": options.fontWeight || 500,
    };
    if (haloColor) {
        Object.assign(attrs, {
            stroke: haloColor,
            "stroke-opacity": options.haloOpacity ?? 1,
            "stroke-width": options.haloWidth ?? options.fontSize * 0.34,
            "paint-order": "stroke",
            "stroke-linejoin": "round",
            "stroke-linecap": "round",
        });
    }

    const node = svgElement("text", attrs);
    node.textContent = text;
    if (options.rotation) node.setAttribute("transform", `rotate(${-options.rotation} ${x} ${y})`);
    svg.appendChild(node);
}

function drawGrid(svg, bounds, map, metrics) {
    const width = bounds.xMax - bounds.xMin;
    const height = bounds.yMax - bounds.yMin;
    const gridSpacing = 50;
    const firstX = Math.ceil(bounds.xMin / gridSpacing) * gridSpacing;
    const firstY = Math.ceil(bounds.yMin / gridSpacing) * gridSpacing;

    for (let x = firstX; x <= bounds.xMax; x += gridSpacing) {
        const [sx] = map([x, 0]);
        const major = Math.round(x / gridSpacing) % 2 === 0;
        svg.appendChild(svgElement("line", {
            x1: sx, y1: 0, x2: sx, y2: height,
            stroke: major ? "#d8dde3" : "#e7eaee",
            "stroke-width": major ? metrics.gridWidth * 1.35 : metrics.gridWidth,
        }));
    }
    for (let y = firstY; y <= bounds.yMax; y += gridSpacing) {
        const [, sy] = map([0, y]);
        const major = Math.round(y / gridSpacing) % 2 === 0;
        svg.appendChild(svgElement("line", {
            x1: 0, y1: sy, x2: width, y2: sy,
            stroke: major ? "#d8dde3" : "#e7eaee",
            "stroke-width": major ? metrics.gridWidth * 1.35 : metrics.gridWidth,
        }));
    }
}

function midpoint(a, b) {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function roomCentroid(vertices) {
    return [
        vertices.reduce((sum, p) => sum + p[0], 0) / vertices.length,
        vertices.reduce((sum, p) => sum + p[1], 0) / vertices.length,
    ];
}

function wallLabelPoint(room, vertices, index, offset) {
    const a = vertices[index];
    const b = vertices[(index + 1) % vertices.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    const [mx, my] = midpoint(a, b);
    const ccw = room.result.orientation === "ccw";
    const nx = ccw ? dy / length : -dy / length;
    const ny = ccw ? -dx / length : dx / length;
    return [mx + nx * offset, my + ny * offset];
}

function angleLabelPoint(room, vertices, index, offset) {
    const n = vertices.length;
    const ccw = room.result.orientation === "ccw";
    const prev = vertices[(index - 1 + n) % n];
    const curr = vertices[index];
    const next = vertices[(index + 1) % n];

    let ux = prev[0] - curr[0], uy = prev[1] - curr[1];
    let vx = next[0] - curr[0], vy = next[1] - curr[1];
    const ul = Math.hypot(ux, uy), vl = Math.hypot(vx, vy);
    ux /= ul; uy /= ul; vx /= vl; vy /= vl;

    let bx = ux + vx, by = uy + vy;
    let bl = Math.hypot(bx, by);
    if (bl < 1e-9) { bx = -uy; by = ux; bl = 1; }
    bx /= bl; by /= bl;

    const turn = (curr[0] - prev[0]) * (next[1] - curr[1]) - (curr[1] - prev[1]) * (next[0] - curr[0]);
    const reflex = ccw ? turn < 0 : turn > 0;
    if (reflex) { bx = -bx; by = -by; }
    return [curr[0] + bx * offset, curr[1] + by * offset];
}

function drawDiagonalLine(svg, a, b, map, metrics) {
    const [x1, y1] = map(a);
    const [x2, y2] = map(b);
    svg.appendChild(svgElement("line", {
        x1, y1, x2, y2,
        stroke: "#d97706",
        "stroke-width": metrics.diagonalWidth,
        "stroke-dasharray": `${metrics.diagonalWidth * 2.4} ${metrics.diagonalWidth * 2.8}`,
        fill: "none",
    }));
}

function drawRoom(svg, room, vertices, bounds, options = {}) {
    const map = worldMapper(bounds);
    const metrics = options.metrics || drawingMetrics(bounds, options.mini);
    const highlights = options.highlights || { walls: new Set(), corners: new Set() };
    const labels = options.labels !== false;
    const n = vertices.length;

    const polygonPoints = vertices.map(p => map(p).join(",")).join(" ");
    svg.appendChild(svgElement("polygon", { points: polygonPoints, fill: "rgba(37,99,235,0.025)", stroke: "none" }));

    room.result.diagonals.forEach(diagonal => {
        const a = vertices[diagonal.from];
        const b = vertices[diagonal.to];
        drawDiagonalLine(svg, a, b, map, metrics);

        if (labels) {
            const [tx, ty] = map(midpoint(a, b));
            addSvgText(svg, tx, ty, diagonal.fitted.toFixed(1), {
                fontSize: metrics.fontSize,
                fill: "#b45309",
                rotation: readableAngle(a, b),
            });
        }
    });

    for (let i = 0; i < n; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % n];
        const [x1, y1] = map(a);
        const [x2, y2] = map(b);
        const highlighted = highlights.walls?.has(i);
        svg.appendChild(svgElement("line", {
            x1, y1, x2, y2,
            stroke: highlighted ? "#16a34a" : "#111827",
            "stroke-width": highlighted ? metrics.highlightWidth : metrics.wallWidth,
            "stroke-linejoin": "round",
            "stroke-linecap": "round",
        }));

        if (labels) {
            const [tx, ty] = map(wallLabelPoint(room, vertices, i, metrics.sideOffset));
            addSvgText(svg, tx, ty, room.result.sides[i].fitted.toFixed(1), {
                fontSize: metrics.fontSize,
                rotation: readableAngle(a, b),
            });
        }
    }

    if (labels) {
        for (let i = 0; i < n; i++) {
            const [tx, ty] = map(angleLabelPoint(room, vertices, i, metrics.angleOffset));
            addSvgText(svg, tx, ty, formatAngle(room.result.angles[i]), { fontSize: metrics.angleFontSize });
        }
    }

    for (let i = 0; i < n; i++) {
        const [cx, cy] = map(vertices[i]);
        const highlighted = highlights.corners?.has(i);
        svg.appendChild(svgElement("circle", {
            cx, cy,
            r: highlighted ? metrics.vertexRadius * 2.1 : metrics.vertexRadius,
            fill: highlighted ? "#16a34a" : "#111827",
            stroke: highlighted ? "white" : "none",
            "stroke-width": highlighted ? metrics.wallWidth * 0.65 : 0,
        }));
    }
}

function createRoomSvg(room, { mini = false, highlights = null, labels = true } = {}) {
    const vertices = room.result.vertices;
    const bounds = boundsForVertices(vertices, mini ? 25 : 50);
    const width = bounds.xMax - bounds.xMin;
    const height = bounds.yMax - bounds.yMin;
    const svg = svgElement("svg", {
        xmlns: SVG_NS,
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: "xMidYMid meet",
    });
    svg.style.background = "white";
    const metrics = drawingMetrics(bounds, mini);
    drawGrid(svg, bounds, worldMapper(bounds), metrics);
    drawRoom(svg, room, vertices, bounds, { mini, highlights, labels, metrics });
    return svg;
}

function downloadSvgAsJpg(svg, filename) {
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", SVG_NS);
    const viewBox = clone.viewBox.baseVal.width ? clone.viewBox.baseVal : svg.viewBox.baseVal;
    const serializer = new XMLSerializer();
    const svgText = serializer.serializeToString(clone);
    const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const image = new Image();

    image.onload = () => {
        const aspect = viewBox.width / viewBox.height;
        const longSide = 3200;
        const canvas = document.createElement("canvas");
        if (aspect >= 1) {
            canvas.width = longSide;
            canvas.height = Math.max(1, Math.round(longSide / aspect));
        } else {
            canvas.height = longSide;
            canvas.width = Math.max(1, Math.round(longSide * aspect));
        }
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);

        const link = document.createElement("a");
        link.download = filename;
        link.href = canvas.toDataURL("image/jpeg", 0.96);
        link.click();
    };
    image.src = url;
}

// =============================================================================
// SAVED ROOMS / SIDEBAR
// =============================================================================

function highlightsForRoom(roomId) {
    const highlights = { walls: new Set(), corners: new Set() };
    if (state.mode !== "combine") return highlights;

    state.combineDraft.forEach(connection => {
        if (connection.roomAId === roomId) {
            if (Number.isInteger(connection.wallA)) highlights.walls.add(connection.wallA);
            if (Number.isInteger(connection.cornerA)) highlights.corners.add(connection.cornerA);
        }
        if (connection.roomBId === roomId) {
            if (Number.isInteger(connection.wallB)) highlights.walls.add(connection.wallB);
            if (Number.isInteger(connection.cornerB)) highlights.corners.add(connection.cornerB);
        }
    });
    return highlights;
}

function renderSidebar() {
    roomsList.innerHTML = "";
    const hasRooms = state.rooms.length > 0;
    $("#roomsEmptyState").classList.toggle("hidden", hasRooms);

    state.rooms.forEach((room, index) => {
        const card = document.createElement("article");
        card.className = "room-card";
        card.draggable = true;
        card.dataset.roomId = room.id;

        const title = document.createElement("div");
        title.className = "room-card-title";
        title.innerHTML = `<span>${index + 1}. ${escapeHtml(room.name)}</span><span class="drag-handle" aria-hidden="true">⋮⋮</span>`;

        const miniWrap = document.createElement("div");
        miniWrap.className = "room-mini-wrap";
        const mini = createRoomSvg(room, { mini: true, labels: false, highlights: highlightsForRoom(room.id) });
        mini.classList.add("room-mini");
        miniWrap.appendChild(mini);

        const actions = document.createElement("div");
        actions.className = "room-card-actions";
        const edit = miniButton("✎", "Edit room", () => loadRoomForEdit(room.id));
        const download = miniButton("⇩", "Download room JPG", () => {
            downloadSvgAsJpg(createRoomSvg(room, { mini: false, labels: true }), `${safeFilename(room.name)}.jpg`);
        });
        const remove = miniButton("×", "Remove room", () => removeRoom(room.id), "remove");
        actions.append(edit, download, remove);

        card.append(title, miniWrap, actions);
        attachDragHandlers(card);
        roomsList.appendChild(card);
    });

    $("#combineButton").classList.toggle("hidden", state.rooms.length < 2);
    updateProjectControls();
}

function miniButton(symbol, title, handler, extraClass = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mini-action ${extraClass}`.trim();
    button.title = title;
    button.setAttribute("aria-label", title);
    button.textContent = symbol;
    button.addEventListener("click", event => {
        event.stopPropagation();
        handler();
    });
    return button;
}

function attachDragHandlers(card) {
    card.addEventListener("dragstart", event => {
        state.draggedRoomId = card.dataset.roomId;
        card.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", state.draggedRoomId);
    });
    card.addEventListener("dragend", () => {
        state.draggedRoomId = null;
        document.querySelectorAll(".room-card").forEach(el => el.classList.remove("dragging", "drag-over"));
    });
    card.addEventListener("dragover", event => {
        event.preventDefault();
        if (card.dataset.roomId !== state.draggedRoomId) card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", event => {
        event.preventDefault();
        card.classList.remove("drag-over");
        const draggedId = state.draggedRoomId || event.dataTransfer.getData("text/plain");
        const targetId = card.dataset.roomId;
        if (!draggedId || draggedId === targetId) return;

        const fromIndex = state.rooms.findIndex(r => r.id === draggedId);
        const toIndex = state.rooms.findIndex(r => r.id === targetId);
        if (fromIndex < 0 || toIndex < 0) return;
        const [moved] = state.rooms.splice(fromIndex, 1);
        state.rooms.splice(toIndex, 0, moved);
        persistRooms();
        invalidateCombinedResult();
        if (state.mode === "combine") initializeCombineDraft();
        renderSidebar();
        if (state.mode === "combine") renderConnections();
    });
}

function removeRoom(roomId) {
    const room = roomById(roomId);
    if (!room) return;
    if (!window.confirm(`Remove ${room.name}?`)) return;
    state.rooms = state.rooms.filter(r => r.id !== roomId);
    persistRooms();
    if (state.editingRoomId === roomId) resetRoomForm();
    invalidateCombinedResult();
    if (state.rooms.length < 2 && state.mode === "combine") showRoomEditor();
    else if (state.mode === "combine") initializeCombineDraft();
    renderSidebar();
    if (state.mode === "combine") renderConnections();
}

// =============================================================================
// COMBINATION WORKFLOW
// =============================================================================

function showRoomEditor() {
    state.mode = "room";
    $("#roomEditor").classList.remove("hidden");
    $("#combineEditor").classList.add("hidden");
    renderSidebar();
}

function showCombineEditor() {
    if (state.rooms.length < 2) return;
    state.mode = "combine";
    $("#roomEditor").classList.add("hidden");
    $("#combineEditor").classList.remove("hidden");
    initializeCombineDraft();
    renderConnections();
    renderSidebar();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function wallEndpoints(room, wallIndex) {
    const n = room.result.vertices.length;
    return [wallIndex, (wallIndex + 1) % n];
}

function defaultConnection(roomAId = null, roomBId = null) {
    const roomA = roomById(roomAId) || state.rooms[0];
    const roomB = roomById(roomBId)
        || state.rooms.find(room => room.id !== roomA?.id)
        || state.rooms[1];

    return {
        roomAId: roomA?.id || null,
        roomBId: roomB?.id || null,
        mode: "parallel",
        wallA: 0,
        wallB: 0,
        cornerA: roomA ? wallEndpoints(roomA, 0)[0] : 0,
        cornerB: roomB ? wallEndpoints(roomB, 0)[0] : 0,
        thickness: 0,
    };
}

function normalizeConnection(connection) {
    const roomA = roomById(connection.roomAId);
    const roomB = roomById(connection.roomBId);
    if (!roomA || !roomB || roomA.id === roomB.id) return false;

    const maxWallA = roomA.result.vertices.length - 1;
    const maxWallB = roomB.result.vertices.length - 1;
    if (!Number.isInteger(connection.wallA) || connection.wallA < 0 || connection.wallA > maxWallA) connection.wallA = 0;
    if (!Number.isInteger(connection.wallB) || connection.wallB < 0 || connection.wallB > maxWallB) connection.wallB = 0;

    const endpointsA = wallEndpoints(roomA, connection.wallA);
    const endpointsB = wallEndpoints(roomB, connection.wallB);
    if (!endpointsA.includes(connection.cornerA)) connection.cornerA = endpointsA[0];
    if (!endpointsB.includes(connection.cornerB)) connection.cornerB = endpointsB[0];
    if (!["parallel", "perpendicular"].includes(connection.mode)) connection.mode = "parallel";
    if (connection.thickness === undefined || connection.thickness === null) connection.thickness = 0;
    return true;
}

function normalizeCombineDraft() {
    state.combineDraft = state.combineDraft.filter(normalizeConnection);
}

function initializeCombineDraft() {
    normalizeCombineDraft();
    if (!state.combineDraft.length && state.rooms.length >= 2) {
        state.combineDraft = [defaultConnection(state.rooms[0].id, state.rooms[1].id)];
    }
}

function addConnection() {
    if (state.rooms.length < 2) return;
    const usedPairs = new Set(state.combineDraft.map(connection => [connection.roomAId, connection.roomBId].sort().join("|")));
    let roomA = state.rooms[0];
    let roomB = state.rooms[1];

    outer:
    for (let i = 0; i < state.rooms.length; i++) {
        for (let j = i + 1; j < state.rooms.length; j++) {
            const key = [state.rooms[i].id, state.rooms[j].id].sort().join("|");
            if (!usedPairs.has(key)) {
                roomA = state.rooms[i];
                roomB = state.rooms[j];
                break outer;
            }
        }
    }

    state.combineDraft.push(defaultConnection(roomA.id, roomB.id));
    renderConnections();
    renderSidebar();
}

function roomSelect(value, excludeId = null) {
    const select = document.createElement("select");
    state.rooms.forEach((room, index) => {
        if (room.id === excludeId) return;
        const option = document.createElement("option");
        option.value = room.id;
        option.textContent = `${index + 1}. ${room.name}`;
        if (room.id === value) option.selected = true;
        select.appendChild(option);
    });
    return select;
}

function wallSelect(room, value) {
    const select = document.createElement("select");
    const n = room.result.vertices.length;
    for (let i = 0; i < n; i++) {
        const [a, b] = wallEndpoints(room, i);
        const option = document.createElement("option");
        option.value = String(i);
        option.textContent = `Wall ${i + 1} (Corner ${a + 1} → Corner ${b + 1})`;
        if (i === value) option.selected = true;
        select.appendChild(option);
    }
    return select;
}

function endpointCornerSelect(room, wallIndex, value) {
    const select = document.createElement("select");
    const endpoints = wallEndpoints(room, wallIndex);
    endpoints.forEach(corner => {
        const option = document.createElement("option");
        option.value = String(corner);
        option.textContent = `Corner ${corner + 1}`;
        if (corner === value) option.selected = true;
        select.appendChild(option);
    });
    if (!endpoints.includes(value)) select.value = String(endpoints[0]);
    return select;
}

function analyzeConnectionGroups() {
    const existingIds = new Set(state.rooms.map(room => room.id));
    const connections = state.combineDraft.filter(connection =>
        existingIds.has(connection.roomAId)
        && existingIds.has(connection.roomBId)
        && connection.roomAId !== connection.roomBId
    );

    const adjacency = new Map();
    const addEdge = (a, b) => {
        if (!adjacency.has(a)) adjacency.set(a, new Set());
        adjacency.get(a).add(b);
    };
    connections.forEach(connection => {
        addEdge(connection.roomAId, connection.roomBId);
        addEdge(connection.roomBId, connection.roomAId);
    });

    const connectedRoomIds = new Set(adjacency.keys());
    const components = [];
    const visited = new Set();

    state.rooms.forEach(room => {
        if (!connectedRoomIds.has(room.id) || visited.has(room.id)) return;
        const component = [];
        const queue = [room.id];
        visited.add(room.id);
        while (queue.length) {
            const id = queue.shift();
            component.push(id);
            for (const next of adjacency.get(id) || []) {
                if (!visited.has(next)) {
                    visited.add(next);
                    queue.push(next);
                }
            }
        }
        components.push(component);
    });

    const firstGroupIds = components[0] || [];
    const otherComponents = components.slice(1);
    const unconnectedIds = state.rooms.filter(room => !connectedRoomIds.has(room.id)).map(room => room.id);
    const roomName = id => roomById(id)?.name || "Unknown room";
    const warnings = [];

    if (otherComponents.length) {
        warnings.push(`Only the first connected group will be plotted (${firstGroupIds.map(roomName).join(", ")}). Independent connected group${otherComponents.length > 1 ? "s" : ""} omitted: ${otherComponents.map(group => group.map(roomName).join(" + ")).join("; ")}.`);
    }
    if (unconnectedIds.length) {
        warnings.push(`Unconnected room${unconnectedIds.length > 1 ? "s" : ""} omitted: ${unconnectedIds.map(roomName).join(", ")}.`);
    }

    return { connections, firstGroupIds, warningText: warnings.join(" ") };
}

function updateCombineWarning() {
    const warning = $("#combineWarning");
    const analysis = analyzeConnectionGroups();
    if (analysis.warningText) showMessage(warning, analysis.warningText);
    else {
        warning.textContent = "";
        warning.classList.add("hidden");
    }
}

function renderConnections() {
    normalizeCombineDraft();
    connectionsList.innerHTML = "";

    state.combineDraft.forEach((connection, index) => {
        const roomA = roomById(connection.roomAId);
        const roomB = roomById(connection.roomBId);
        if (!roomA || !roomB) return;

        const card = document.createElement("div");
        card.className = "connection-card";

        const title = document.createElement("div");
        title.className = "connection-title";
        const heading = document.createElement("h3");
        heading.textContent = `Connection ${index + 1}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "icon-button remove connection-remove";
        remove.title = "Remove connection";
        remove.setAttribute("aria-label", "Remove connection");
        remove.textContent = "×";
        remove.addEventListener("click", () => {
            state.combineDraft.splice(index, 1);
            renderConnections();
            renderSidebar();
        });
        title.append(heading, remove);

        const rows = document.createElement("div");
        rows.className = "connection-rows";

        // Row 1: both rooms + connection type.
        const roomRow = document.createElement("div");
        roomRow.className = "connection-row rooms";

        const roomAField = connectionField("Room");
        const roomASelect = roomSelect(roomA.id, roomB.id);
        roomASelect.addEventListener("change", () => {
            connection.roomAId = roomASelect.value;
            connection.wallA = 0;
            const selectedRoom = roomById(connection.roomAId);
            connection.cornerA = wallEndpoints(selectedRoom, 0)[0];
            renderConnections();
            renderSidebar();
        });
        roomAField.appendChild(roomASelect);

        const roomBField = connectionField("Room connected to");
        const roomBSelect = roomSelect(roomB.id, roomA.id);
        roomBSelect.addEventListener("change", () => {
            connection.roomBId = roomBSelect.value;
            connection.wallB = 0;
            const selectedRoom = roomById(connection.roomBId);
            connection.cornerB = wallEndpoints(selectedRoom, 0)[0];
            renderConnections();
            renderSidebar();
        });
        roomBField.appendChild(roomBSelect);

        const modeField = connectionField("Connection type");
        const mode = document.createElement("select");
        mode.innerHTML = `
            <option value="parallel">Parallel walls</option>
            <option value="perpendicular">Perpendicular walls (touching corners)</option>
        `;
        mode.value = connection.mode;
        mode.addEventListener("change", () => {
            connection.mode = mode.value;
            renderSidebar();
        });
        modeField.appendChild(mode);
        roomRow.append(roomAField, roomBField, modeField);

        // Row 2: selected walls side by side.
        const wallRow = document.createElement("div");
        wallRow.className = "connection-row pair";
        const wallAField = connectionField(`Wall from ${roomA.name}`);
        const wallA = wallSelect(roomA, connection.wallA);
        wallA.addEventListener("change", () => {
            connection.wallA = Number(wallA.value);
            connection.cornerA = wallEndpoints(roomA, connection.wallA)[0];
            renderConnections();
            renderSidebar();
        });
        wallAField.appendChild(wallA);

        const wallBField = connectionField(`Wall from ${roomB.name}`);
        const wallB = wallSelect(roomB, connection.wallB);
        wallB.addEventListener("change", () => {
            connection.wallB = Number(wallB.value);
            connection.cornerB = wallEndpoints(roomB, connection.wallB)[0];
            renderConnections();
            renderSidebar();
        });
        wallBField.appendChild(wallB);
        wallRow.append(wallAField, wallBField);

        // Row 3: selected touching corners side by side.
        const cornerRow = document.createElement("div");
        cornerRow.className = "connection-row pair";
        const cornerAField = connectionField(`Touching corner from ${roomA.name}`);
        const cornerA = endpointCornerSelect(roomA, connection.wallA, connection.cornerA);
        connection.cornerA = Number(cornerA.value);
        cornerA.addEventListener("change", () => {
            connection.cornerA = Number(cornerA.value);
            renderSidebar();
        });
        cornerAField.appendChild(cornerA);

        const cornerBField = connectionField(`Touching corner from ${roomB.name}`);
        const cornerB = endpointCornerSelect(roomB, connection.wallB, connection.cornerB);
        connection.cornerB = Number(cornerB.value);
        cornerB.addEventListener("change", () => {
            connection.cornerB = Number(cornerB.value);
            renderSidebar();
        });
        cornerBField.appendChild(cornerB);
        cornerRow.append(cornerAField, cornerBField);

        const thicknessRow = document.createElement("div");
        thicknessRow.className = "connection-row single";
        const thicknessField = connectionField("Thickness of division (cm)");
        const thickness = document.createElement("input");
        thickness.type = "number";
        thickness.min = "0";
        thickness.step = "0.01";
        thickness.inputMode = "decimal";
        thickness.value = connection.thickness;
        thickness.addEventListener("input", () => connection.thickness = thickness.value);
        thicknessField.appendChild(thickness);
        thicknessRow.appendChild(thicknessField);

        rows.append(roomRow, wallRow, cornerRow, thicknessRow);
        const note = document.createElement("p");
        note.className = "connection-note";
        note.textContent = "Selected walls and corners are highlighted in green in the corresponding room miniatures.";
        card.append(title, rows, note);
        connectionsList.appendChild(card);
    });

    updateCombineWarning();
}

function connectionField(label, extraClass = "") {
    const field = document.createElement("label");
    field.className = `connection-field ${extraClass || ""}`.trim();
    const text = document.createElement("span");
    text.textContent = label;
    field.appendChild(text);
    return field;
}

function vector(a, b) {
    return [b[0] - a[0], b[1] - a[1]];
}

function normalize(v) {
    const length = Math.hypot(v[0], v[1]);
    if (length < 1e-12) throw new Error("A selected wall has zero length.");
    return [v[0] / length, v[1] / length];
}

function rotateVector(v, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return [c * v[0] - s * v[1], s * v[0] + c * v[1]];
}

function angleBetweenVectors(from, to) {
    return Math.atan2(to[1], to[0]) - Math.atan2(from[1], from[0]);
}

function transformVertices(vertices, angle, sourceAnchor, targetAnchor) {
    const rotatedAnchor = rotateVector(sourceAnchor, angle);
    const tx = targetAnchor[0] - rotatedAnchor[0];
    const ty = targetAnchor[1] - rotatedAnchor[1];
    return vertices.map(point => {
        const rotated = rotateVector(point, angle);
        return [rotated[0] + tx, rotated[1] + ty];
    });
}

function outwardNormal(room, placedVertices, wallIndex) {
    const [aIndex, bIndex] = wallEndpoints(room, wallIndex);
    const a = placedVertices[aIndex];
    const b = placedVertices[bIndex];
    const dir = normalize(vector(a, b));
    return room.result.orientation === "ccw" ? [dir[1], -dir[0]] : [-dir[1], dir[0]];
}

function directionFromCorner(room, vertices, wallIndex, cornerIndex) {
    const endpoints = wallEndpoints(room, wallIndex);
    if (!endpoints.includes(cornerIndex)) throw new Error("The selected touching corner must belong to the selected wall.");
    const other = endpoints[0] === cornerIndex ? endpoints[1] : endpoints[0];
    return normalize(vector(vertices[cornerIndex], vertices[other]));
}

function placeNextRoom(roomA, placedA, roomB, connection) {
    const thickness = Number(connection.thickness);
    if (!Number.isFinite(thickness) || thickness < 0) throw new Error("Division thickness must be zero or a positive number.");

    const verticesB = roomB.result.vertices;
    const anchorA = placedA[connection.cornerA];
    const anchorB = verticesB[connection.cornerB];
    const dirA = directionFromCorner(roomA, placedA, connection.wallA, connection.cornerA);
    const dirB = directionFromCorner(roomB, verticesB, connection.wallB, connection.cornerB);
    const normalA = outwardNormal(roomA, placedA, connection.wallA);
    const targetAnchor = [anchorA[0] + normalA[0] * thickness, anchorA[1] + normalA[1] * thickness];

    if (connection.mode === "parallel") {
        const rotation = angleBetweenVectors(dirB, dirA);
        return transformVertices(verticesB, rotation, anchorB, targetAnchor);
    }

    if (connection.mode === "perpendicular") {
        const targetPlus = rotateVector(dirA, Math.PI / 2);
        const targetMinus = rotateVector(dirA, -Math.PI / 2);
        const candidates = [targetPlus, targetMinus].map(target => {
            const rotation = angleBetweenVectors(dirB, target);
            const placed = transformVertices(verticesB, rotation, anchorB, targetAnchor);
            const centroid = roomCentroid(placed);
            const outwardScore = (centroid[0] - anchorA[0]) * normalA[0] + (centroid[1] - anchorA[1]) * normalA[1];
            return { placed, outwardScore };
        });
        candidates.sort((a, b) => b.outwardScore - a.outwardScore);
        return candidates[0].placed;
    }

    throw new Error("Unknown room connection type.");
}

function reverseConnection(connection) {
    return {
        roomAId: connection.roomBId,
        roomBId: connection.roomAId,
        mode: connection.mode,
        wallA: connection.wallB,
        wallB: connection.wallA,
        cornerA: connection.cornerB,
        cornerB: connection.cornerA,
        thickness: connection.thickness,
    };
}

function buildCombinedLayout() {
    if (state.rooms.length < 2) throw new Error("Add at least two rooms before combining them.");
    normalizeCombineDraft();
    if (!state.combineDraft.length) throw new Error("Add at least one connection before generating the combined shape.");

    const analysis = analyzeConnectionGroups();
    if (!analysis.firstGroupIds.length) throw new Error("No valid room connections have been defined.");

    const groupIds = new Set(analysis.firstGroupIds);
    const groupConnections = analysis.connections.filter(connection => groupIds.has(connection.roomAId) && groupIds.has(connection.roomBId));
    const firstRoom = roomById(analysis.firstGroupIds[0]);
    const placements = new Map([[firstRoom.id, deepCopy(firstRoom.result.vertices)]]);
    const usedConnections = new Set();

    while (placements.size < groupIds.size) {
        let progress = false;
        for (let index = 0; index < groupConnections.length; index++) {
            const connection = groupConnections[index];
            const aPlaced = placements.has(connection.roomAId);
            const bPlaced = placements.has(connection.roomBId);
            if (aPlaced === bPlaced) continue;

            const oriented = aPlaced ? connection : reverseConnection(connection);
            const roomA = roomById(oriented.roomAId);
            const roomB = roomById(oriented.roomBId);
            placements.set(roomB.id, placeNextRoom(roomA, placements.get(roomA.id), roomB, oriented));
            usedConnections.add(index);
            progress = true;
        }
        if (!progress) throw new Error("The first connected room group could not be positioned from the supplied connections.");
    }

    const layout = state.rooms
        .filter(room => groupIds.has(room.id))
        .map(room => ({ room, vertices: placements.get(room.id) }));

    const cycleCount = Math.max(0, groupConnections.length - usedConnections.size);
    return { layout, analysis, cycleCount };
}

const COMBINED_ROOM_COLORS = [
    "#2563eb", "#dc2626", "#16a34a", "#9333ea", "#0891b2", "#ca8a04",
    "#db2777", "#4f46e5", "#059669", "#ea580c", "#7c3aed", "#0f766e",
];

function combinedRoomColor(index) {
    if (index < COMBINED_ROOM_COLORS.length) return COMBINED_ROOM_COLORS[index];
    const hue = Math.round((index * 137.508) % 360);
    return `hsl(${hue} 68% 43%)`;
}

function formatCombinedAngle(value) {
    const rounded = Math.round(Number(value) * 2) / 2;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}º`;
}

function formatCombinedMeasure(value) {
    const rounded = Math.round(Number(value) * 10) / 10;
    return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

function drawCombinedWallLines(svg, layout, bounds, metrics) {
    const map = worldMapper(bounds);
    layout.forEach((item, roomIndex) => {
        const color = combinedRoomColor(roomIndex);
        const vertices = item.vertices;
        for (let i = 0; i < vertices.length; i++) {
            const [x1, y1] = map(vertices[i]);
            const [x2, y2] = map(vertices[(i + 1) % vertices.length]);
            svg.appendChild(svgElement("line", {
                x1, y1, x2, y2,
                stroke: color,
                "stroke-width": metrics.wallWidth * 1.15,
                "stroke-linejoin": "round",
                "stroke-linecap": "round",
            }));
        }
    });
}

function drawCombinedDiagonalLines(svg, layout, bounds, metrics) {
    const map = worldMapper(bounds);
    layout.forEach(item => {
        item.room.result.diagonals.forEach(diagonal => {
            drawDiagonalLine(svg, item.vertices[diagonal.from], item.vertices[diagonal.to], map, metrics);
        });
    });
}

function drawCombinedAngleLabels(svg, layout, bounds, metrics) {
    const map = worldMapper(bounds);
    layout.forEach(item => {
        for (let i = 0; i < item.vertices.length; i++) {
            const [tx, ty] = map(angleLabelPoint(item.room, item.vertices, i, metrics.angleOffset));
            addSvgText(svg, tx, ty, formatCombinedAngle(item.room.result.angles[i]), {
                fontSize: metrics.angleFontSize,
                fill: "#6b7280",
                opacity: 0.5,
                haloColor: null,
            });
        }
    });
}

function drawCombinedDiagonalMeasures(svg, layout, bounds, metrics) {
    const map = worldMapper(bounds);
    layout.forEach(item => {
        item.room.result.diagonals.forEach(diagonal => {
            const a = item.vertices[diagonal.from];
            const b = item.vertices[diagonal.to];
            const [tx, ty] = map(midpoint(a, b));
            addSvgText(svg, tx, ty, formatCombinedMeasure(diagonal.fitted), {
                fontSize: metrics.fontSize,
                fill: "#d97706",
                haloColor: "white",
                haloOpacity: 0.4,
                haloWidth: metrics.fontSize * 0.42,
                rotation: readableAngle(a, b),
            });
        });
    });
}

function drawCombinedWallMeasures(svg, layout, bounds, metrics) {
    const map = worldMapper(bounds);
    layout.forEach((item, roomIndex) => {
        const room = item.room;
        const vertices = item.vertices;
        // const wallColor = combinedRoomColor(roomIndex);
        for (let i = 0; i < vertices.length; i++) {
            const a = vertices[i];
            const b = vertices[(i + 1) % vertices.length];
            const [tx, ty] = map(wallLabelPoint(room, vertices, i, 0));                     // Set metrics.sideOffset = 0
            addSvgText(svg, tx, ty, formatCombinedMeasure(room.result.sides[i].fitted), {
                fontSize: metrics.fontSize,
                fill: "#000000",
                haloColor: "white",
                haloOpacity: 0.4,
                haloWidth: metrics.fontSize * 0.42,
                rotation: readableAngle(a, b),
            });
        }
    });
}

function legendEntryWidth(name, metrics) {
    return metrics.swatchLength + metrics.textGap + name.length * metrics.fontSize * 0.58;
}

function buildCombinedLegendLayout(layout, plotWidth, plotHeight, metrics) {
    const legendMetrics = {
        fontSize: metrics.fontSize * 0.82,
        lineHeight: metrics.fontSize * 1.35,
        swatchLength: metrics.fontSize * 1.8,
        textGap: metrics.fontSize * 0.55,
        padding: metrics.fontSize * 0.8,
        itemGap: metrics.fontSize * 1.4,
        plotGap: metrics.fontSize * 1.4,
    };
    const entries = layout.map((item, index) => ({
        name: item.room.name,
        color: combinedRoomColor(index),
    }));

    if (plotWidth < plotHeight) {
        const maxEntryWidth = Math.max(...entries.map(entry => legendEntryWidth(entry.name, legendMetrics)), 0);
        const legendWidth = legendMetrics.padding * 2 + maxEntryWidth;
        const legendHeight = legendMetrics.padding * 2 + entries.length * legendMetrics.lineHeight;
        return {
            orientation: "right",
            legendMetrics,
            entries,
            totalWidth: plotWidth + legendMetrics.plotGap + legendWidth,
            totalHeight: Math.max(plotHeight, legendHeight),
            plotX: 0,
            plotY: 0,
            legendX: plotWidth + legendMetrics.plotGap,
            legendY: 0,
        };
    }

    const entryWidths = entries.map(entry => legendEntryWidth(entry.name, legendMetrics));
    const totalWidth = Math.max(plotWidth, Math.max(...entryWidths, 0) + legendMetrics.padding * 2);
    const availableWidth = totalWidth - legendMetrics.padding * 2;
    const rows = [];
    let row = [];
    let rowWidth = 0;

    entries.forEach((entry, index) => {
        const width = entryWidths[index];
        const added = row.length ? legendMetrics.itemGap + width : width;
        if (row.length && rowWidth + added > availableWidth) {
            rows.push({ entries: row, width: rowWidth });
            row = [];
            rowWidth = 0;
        }
        row.push({ ...entry, width });
        rowWidth += row.length > 1 ? legendMetrics.itemGap + width : width;
    });
    if (row.length) rows.push({ entries: row, width: rowWidth });

    const legendHeight = legendMetrics.padding * 2 + rows.length * legendMetrics.lineHeight;
    return {
        orientation: "top",
        legendMetrics,
        rows,
        totalWidth,
        totalHeight: legendHeight + legendMetrics.plotGap + plotHeight,
        plotX: (totalWidth - plotWidth) / 2,
        plotY: legendHeight + legendMetrics.plotGap,
        legendX: 0,
        legendY: 0,
    };
}

function drawLegendEntry(svg, entry, x, y, metrics) {
    const x2 = x + metrics.swatchLength;
    svg.appendChild(svgElement("line", {
        x1: x, y1: y, x2, y2: y,
        stroke: entry.color,
        "stroke-width": Math.max(metrics.fontSize * 0.18, 1),
        "stroke-linecap": "round",
    }));
    const text = svgElement("text", {
        x: x2 + metrics.textGap,
        y,
        "font-size": metrics.fontSize,
        fill: "#374151",
        "text-anchor": "start",
        "dominant-baseline": "middle",
        "font-family": "Inter, Arial, sans-serif",
        "font-weight": 600,
    });
    text.textContent = entry.name;
    svg.appendChild(text);
}

function drawCombinedLegend(svg, legendLayout) {
    const metrics = legendLayout.legendMetrics;

    if (legendLayout.orientation === "right") {
        legendLayout.entries.forEach((entry, index) => {
            const x = legendLayout.legendX + metrics.padding;
            const y = legendLayout.legendY + metrics.padding + metrics.lineHeight * (index + 0.5);
            drawLegendEntry(svg, entry, x, y, metrics);
        });
        return;
    }

    legendLayout.rows.forEach((row, rowIndex) => {
        let x = legendLayout.totalWidth - metrics.padding - row.width;
        const y = legendLayout.legendY + metrics.padding + metrics.lineHeight * (rowIndex + 0.5);
        row.entries.forEach(entry => {
            drawLegendEntry(svg, entry, x, y, metrics);
            x += entry.width + metrics.itemGap;
        });
    });
}

function renderCombined(layout) {
    combinedGraph.innerHTML = "";
    const bounds = boundsForMany(layout.map(item => item.vertices), 50);
    const plotWidth = bounds.xMax - bounds.xMin;
    const plotHeight = bounds.yMax - bounds.yMin;
    const metrics = drawingMetrics(bounds, false);
    const legendLayout = buildCombinedLegendLayout(layout, plotWidth, plotHeight, metrics);

    combinedGraph.setAttribute("viewBox", `0 0 ${legendLayout.totalWidth} ${legendLayout.totalHeight}`);
    combinedGraph.setAttribute("preserveAspectRatio", "xMidYMid meet");
    combinedGraph.style.aspectRatio = `${legendLayout.totalWidth} / ${legendLayout.totalHeight}`;

    const plotGroup = svgElement("g", {
        transform: `translate(${legendLayout.plotX} ${legendLayout.plotY})`,
    });
    combinedGraph.appendChild(plotGroup);

    // Explicit plot layer order, bottom to top.
    drawCombinedDiagonalLines(plotGroup, layout, bounds, metrics);
    drawCombinedDiagonalMeasures(plotGroup, layout, bounds, metrics);
    drawCombinedWallLines(plotGroup, layout, bounds, metrics);
    drawCombinedAngleLabels(plotGroup, layout, bounds, metrics);
    drawCombinedWallMeasures(plotGroup, layout, bounds, metrics);

    drawCombinedLegend(combinedGraph, legendLayout);
}

function generateCombinedShape() {
    clearMessages();
    try {
        const combined = buildCombinedLayout();
        state.combinedLayout = combined.layout;
        renderCombined(combined.layout);

        const messages = [`${combined.layout.length} connected room${combined.layout.length === 1 ? "" : "s"} plotted.`];
        if (combined.analysis.warningText) messages.push(combined.analysis.warningText);
        if (combined.cycleCount) messages.push(`${combined.cycleCount} additional connection${combined.cycleCount === 1 ? "" : "s"} formed a cycle and did not reposition rooms that were already placed.`);
        $("#combinedSummary").textContent = messages.join(" ");
        $("#combinedResultCard").classList.remove("hidden");
        $("#combinedResultCard").scrollIntoView({ behavior: "smooth", block: "start" });
        updateCombineWarning();
    } catch (error) {
        showMessage($("#combineError"), error.message || "The rooms could not be combined.");
    }
}

// =============================================================================
// SMALL HELPERS / EVENTS
// =============================================================================

function safeFilename(name) {
    return (name || "room-shape").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "room-shape";
}

function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    })[char]);
}

$("#wallCount").addEventListener("change", event => resizeWalls(Number(event.target.value)));
$("#roomName").addEventListener("input", event => state.roomName = event.target.value);
document.querySelectorAll('input[name="orientation"]').forEach(input => {
    input.addEventListener("change", () => state.orientation = input.value);
});

generateButton.addEventListener("click", generateRoom);
$("#cancelEditButton").addEventListener("click", () => resetRoomForm());
$("#combineButton").addEventListener("click", showCombineEditor);
$("#addConnectionButton").addEventListener("click", addConnection);
$("#backToRoomsButton").addEventListener("click", showRoomEditor);
$("#generateCombinedButton").addEventListener("click", generateCombinedShape);
$("#downloadCombinedButton").addEventListener("click", () => {
    if (state.combinedLayout) downloadSvgAsJpg(combinedGraph, "combined-floorplan.jpg");
});

$("#helpButton").addEventListener("click", () => helpDialog.showModal());
$("#closeHelpButton").addEventListener("click", () => helpDialog.close());
helpDialog.addEventListener("click", event => {
    if (event.target === helpDialog) helpDialog.close();
});

exportProjectButton.addEventListener("click", exportProject);
importProjectButton.addEventListener("click", () => importProjectInput.click());
importProjectInput.addEventListener("change", async () => {
    const file = importProjectInput.files?.[0];
    if (!file) return;

    const hasCurrentProject = state.rooms.length || hasMeaningfulDraftData();
    if (hasCurrentProject && !window.confirm("Importing a project will replace the rooms, connections and current form in this browser. Continue?")) {
        importProjectInput.value = "";
        return;
    }

    importProjectButton.disabled = true;
    exportProjectButton.disabled = true;
    try {
        await importProject(file);
    } catch (error) {
        console.error(error);
        showRoomEditor();
        clearMessages();
        showMessage($("#formError"), error.message || "The project could not be imported.");
    } finally {
        importProjectInput.value = "";
        importProjectButton.disabled = !state.solverReady;
        updateProjectControls();
    }
});

document.addEventListener("input", event => {
    if (event.target.closest?.("#roomEditor")) updateProjectControls();
});
document.addEventListener("change", event => {
    if (event.target.closest?.("#roomEditor")) updateProjectControls();
});

state.rooms = loadRooms();
initializeWallCountSelect();
resetRoomForm();
renderSidebar();
initializeSolver();
