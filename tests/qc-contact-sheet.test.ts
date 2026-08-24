import {
  buildContactSheetFfmpegArgs,
  createContactSheetLayout,
} from "../scripts/qc-contact-sheet";

const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
};

const deepEqual = (actual: unknown, expected: unknown, label: string): void => {
  equal(JSON.stringify(actual), JSON.stringify(expected), label);
};

deepEqual(createContactSheetLayout(1), {
  columns: 1,
  rows: 1,
  positions: ["0_0"],
}, "one input creates a 1x1 grid");

for (const inputCount of [2, 3, 4]) {
  const layout = createContactSheetLayout(inputCount);
  equal(layout.columns, inputCount, `${inputCount} inputs use a compact single row`);
  equal(layout.rows, 1, `${inputCount} inputs do not add an empty row`);
}

deepEqual(createContactSheetLayout(5), {
  columns: 4,
  rows: 2,
  positions: ["0_0", "w0_0", "w0+w0_0", "w0+w0+w0_0", "0_h0"],
}, "five inputs wrap to a second row in checkpoint order");

const sixteenInputLayout = createContactSheetLayout(16);
equal(sixteenInputLayout.columns, 4, "sixteen inputs use four columns");
equal(sixteenInputLayout.rows, 4, "sixteen inputs use four rows");
equal(sixteenInputLayout.positions.length, 16, "all sixteen inputs receive positions");
equal(sixteenInputLayout.positions[3], "w0+w0+w0_0", "the first row ends at column four");
equal(sixteenInputLayout.positions[4], "0_h0", "the fifth input starts the second row");
equal(sixteenInputLayout.positions[15], "w0+w0+w0_h0+h0+h0", "the final input occupies the bottom-right cell");

const inputs = ["/qc/first.png", "/qc/second.png", "/qc/third.png", "/qc/fourth.png", "/qc/fifth.png"];
const args = buildContactSheetFfmpegArgs(inputs, "/qc/contact-sheet.png");
equal(args.filter((argument) => argument === "-i").length, inputs.length, "every checkpoint is included as an ffmpeg input");
deepEqual(
  args.flatMap((argument, index) => argument === "-i" ? [args[index + 1]] : []),
  inputs,
  "ffmpeg inputs preserve checkpoint order",
);
equal(
  args[args.indexOf("-filter_complex") + 1],
  "[0:v][1:v][2:v][3:v][4:v]xstack=inputs=5:layout=0_0|w0_0|w0+w0_0|w0+w0+w0_0|0_h0:fill=black[contact-sheet]",
  "the ffmpeg filter graph is deterministic and leaves unused final-row cells black",
);
equal(args[args.length - 1], "/qc/contact-sheet.png", "the requested contact-sheet output path is preserved");
deepEqual(
  buildContactSheetFfmpegArgs(inputs, "/qc/contact-sheet.png"),
  args,
  "ffmpeg argument construction is deterministic",
);

equal(
  buildContactSheetFfmpegArgs(["/qc/only.png"], "/qc/contact-sheet.png")[4],
  "[0:v]null[contact-sheet]",
  "a single input uses a valid pass-through filter",
);

console.log("QC contact-sheet layout tests passed");
