import tkinter as tk
from tkinter import messagebox
from filler import WordList, fill, format_grid

words = None

def run_crossword():
    global words
    if not cells:
        messagebox.showerror("Input Error", "Create a grid first.")
        return

    grid_data = []
    for row_vars in cells:
        row = []
        for cell in row_vars:
            val = cell.get().strip().upper()
            row.append('■' if val == '.' else (val if val else ' '))
        grid_data.append(row)

    if words is None:
        words = WordList.from_folder()
    result = fill(grid_data, words)
    print(result.stats)
    if not result.success:
        messagebox.showinfo("No fill", result.reason)
        return

    print(format_grid(result.grid))
    for r, row in enumerate(result.grid):
        for c, letter in enumerate(row):
            cells[r][c].set(letter)

def create_grid():
    global cells, entries, current_direction
    try:
        rows = int(rows_entry.get())
        cols = int(cols_entry.get())
    except ValueError:
        messagebox.showerror("Input Error", "Enter valid grid size")
        return

    for widget in grid_frame.winfo_children():
        widget.destroy()

    cells = [[tk.StringVar() for _ in range(cols)] for _ in range(rows)]
    entries = [[None for _ in range(cols)] for _ in range(rows)]

    for r in range(rows):
        for c in range(cols):
            entry = tk.Entry(grid_frame, textvariable=cells[r][c], width=2, justify='center', font=('Consolas', 14), bd=1, relief='solid', insertontime=0)
            entry.grid(row=r, column=c, padx=1, pady=1)
            entry.bind("<KeyRelease>", lambda e, row=r, col=c: on_key(e, row, col))
            entry.bind("<FocusIn>", lambda e, row=r, col=c: highlight_row_col(row, col))
            entry.config(takefocus=True, insertbackground='white', insertwidth=0)  # Hide cursor
            entries[r][c] = entry

    entries[0][0].focus_set()
    highlight_row_col(0, 0)

def highlight_row_col(row, col):
    rows = len(entries)
    cols = len(entries[0])
    for r in range(rows):
        for c in range(cols):
            entries[r][c].config(bg='white')

    if current_direction == "Across":
        for c in range(cols):
            entries[row][c].config(bg='#e0f0ff')
    else:
        for r in range(rows):
            entries[r][col].config(bg='#e0f0ff')

    entries[row][col].config(bg='#c0e0ff')

def on_key(event, row, col):
    global current_direction
    key = event.keysym
    char = event.char.upper()
    rows = len(cells)
    cols = len(cells[0])

    if key == "BackSpace":
        cells[row][col].set("")
        if current_direction == "Across" and col > 0:
            col -= 1
        elif current_direction == "Down" and row > 0:
            row -= 1
        entries[row][col].focus_set()
    elif key in ["Left", "Right", "Up", "Down"]:
        # Switch direction before moving
        if key in ["Left", "Right"]:
            if current_direction == "Down":
                current_direction = "Across"
                highlight_row_col(row, col)
                return
        elif key in ["Up", "Down"]:
            if current_direction == "Across":
                current_direction = "Down"
                highlight_row_col(row, col)
                return

        if key == "Left" and col > 0:
            col -= 1
        elif key == "Right" and col < cols - 1:
            col += 1
        elif key == "Up" and row > 0:
            row -= 1
        elif key == "Down" and row < rows - 1:
            row += 1
        entries[row][col].focus_set()
        highlight_row_col(row, col)
    elif char.isalpha() or char == ".":
        if char == ".":
            cells[row][col].set('■')
        else:
            # Only replace the letter if the square already has a letter
            if cells[row][col].get() == "" or cells[row][col].get() != char[0].upper():
                cells[row][col].set(char[0].upper())
        if current_direction == "Across" and col < cols - 1:
            col += 1
        elif current_direction == "Down" and row < rows - 1:
            row += 1
        entries[row][col].focus_set()
        highlight_row_col(row, col)

root = tk.Tk()
root.title("Crossword Input")

control_frame = tk.Frame(root)
control_frame.pack(pady=10)

tk.Label(control_frame, text="Rows:").grid(row=0, column=0)
rows_entry = tk.Entry(control_frame, width=4)
rows_entry.insert(0, "15")
rows_entry.grid(row=0, column=1)

tk.Label(control_frame, text="Cols:").grid(row=0, column=2)
cols_entry = tk.Entry(control_frame, width=4)
cols_entry.insert(0, "15")
cols_entry.grid(row=0, column=3)

tk.Button(control_frame, text="Create Grid", command=create_grid).grid(row=0, column=4, padx=10)
tk.Button(control_frame, text="Run", command=run_crossword).grid(row=0, column=5)

grid_frame = tk.Frame(root)
grid_frame.pack()

cells = []
entries = []
current_direction = "Across"

root.mainloop()
