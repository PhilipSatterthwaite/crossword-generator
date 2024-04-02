import sys
import os
sys.path.append(r'C:\Users\psatt\AppData\Local\Packages\PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0\LocalCache\local-packages\Python311\site-packages')
from PyQt5.QtWidgets import QApplication, QMainWindow, QLabel, QLineEdit, QPushButton, QVBoxLayout, QGraphicsView, QGraphicsScene, QGraphicsRectItem, QGraphicsTextItem, QWidget
from PyQt5.QtGui import QPen, QBrush, QColor, QFont, QPainter
from PyQt5.QtCore import Qt, QRectF, pyqtSignal, QRunnable, QThreadPool, QObject
from copy import deepcopy
parent_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.append(parent_dir)
from Crossword_Generator import Generate


class ClickableRectItem(QPushButton):
    clicked = pyqtSignal(int, int)
    def __init__(self, x, y, size):
        super().__init__()
        self.setGeometry(x, y, size, size)
        self.size = size

    def setStyle(self, background_color, border_color):
        style = f"background-color: {background_color}; border: 1px solid {border_color};"
        self.setStyleSheet(style)

    def mousePressEvent(self, event):
        self.clicked.emit(
            int(self.pos().x() / self.size),
            int(self.pos().y() / self.size),
        )

class EditableTextItem(QGraphicsTextItem):
    textChanged = pyqtSignal(str, int, int)  # Custom signal to track text changes and grid coordinates
    clicked = pyqtSignal(int, int)  # Custom signal to track click events

    #def keyPressEvent(self, event):
    #    super().keyPressEvent(event)
    #    self.textChanged.emit(self.toPlainText(), int(self.x() / self.boundingRect().width()), int(self.y() / self.boundingRect().height()))

    #def mousePressEvent(self, event):
    #    self.clicked.emit(int(self.pos().x() / self.boundingRect().width()), int(self.pos().y() / self.boundingRect().height()))

class SizeInputApp(QMainWindow):
    def __init__(self):
        super().__init__()

        self.setWindowTitle("Square Grid App")
        self.setGeometry(100, 100, 600, 600)

        # Create a central widget
        self.central_widget = QWidget()
        self.setCentralWidget(self.central_widget)

        # Set a layout for the central widget
        #layout = QVBoxLayout()
        layout = QVBoxLayout(self.central_widget)

        # Create label and entry for user input
        self.label = QLabel("Enter a number:")
        self.label.setStyleSheet("background-color: white")
        layout.addWidget(self.label)

        self.entry = QLineEdit()
        self.entry.setStyleSheet("background-color: white")
        layout.addWidget(self.entry)

        # Create submit button
        self.submit_button = QPushButton("Submit")
        self.submit_button.setStyleSheet("background-color: white")
        self.submit_button.clicked.connect(self.create_grid)
        layout.addWidget(self.submit_button)

        # Create a QGraphicsView to draw the grid
        self.scene = QGraphicsScene()
        self.view = QGraphicsView(self.scene)
        self.view.setAlignment(Qt.AlignCenter)
        layout.addWidget(self.view)

        # Set the layout for the central widget
        self.central_widget.setLayout(layout)

        # Initialize size variable and grid data
        self.size = None
        self.grid_data = None
        self.grid_rects = None
        self.active_text_item = None
        self.active_square = [0,0]
        self.square_size = 10
        self.gui_starting = True


        # Create the "Run" button
        self.run_button = QPushButton("Run")
        self.run_button.setStyleSheet("background-color: white")
        self.run_button.clicked.connect(self.run_crossword_generator)
        layout.addWidget(self.run_button)

        # Create the "Stop" button
        self.stop_button = QPushButton("Stop")
        self.stop_button.setStyleSheet("background-color: white")
        #self.stop_button.clicked.connect(self.stop_crossword_generator)
        layout.addWidget(self.stop_button)

        self.installEventFilter(self)

    def keyPressEvent(self, event):
        if self.active_square is None:
            return

        i, j = self.active_square
        key = event.key()

        if key == Qt.Key_Backspace:
            self.grid_data[i][j] = ' '  # Clear the square on Backspace
            self.text_items[i][j] = ' '
            self.grid_rects[i][j].setText(' ')
        elif Qt.Key_A <= key <= Qt.Key_Z:
            self.grid_data[i][j] = chr(key)  # Update with the entered character
            self.text_items[i][j] = chr(key)
            self.grid_rects[i][j].setText(chr(key))
        elif key == Qt.Key_Period:  # Handle period key
            self.grid_data[i][j] = '.'
            self.text_items[i][j] = '.'
            self.grid_rects[i][j].setStyle("black", "black")
        #self.draw_grid()
        super().keyPressEvent(event)

    def resizeEvent(self, event):
        # Override the resizeEvent method to handle window resizing
        if not self.gui_starting:
            self.resize_grid(event)

    def handle_arrow_key(self, key):
        i, j = self.active_square

        if key == Qt.Key_Up and j > 0:
            j -= 1
        elif key == Qt.Key_Down and j < self.size - 1:
            j += 1
        elif key == Qt.Key_Left and i > 0:
            i -= 1
        elif key == Qt.Key_Right and i < self.size - 1:
            i += 1
        self.update_active(i, j)

    def create_grid(self):
        # Retrieve user input and store it in the "size" variable

        try:
            self.size = int(self.entry.text())
            self.square_size = min(self.width(), self.height()) / self.size

            self.initialize_grid()

            self.scene.clear()
            self.draw_grid()
        except ValueError:
            self.label.setText("Invalid input. Please enter a valid number.")
        self.gui_starting = False

    def initialize_grid(self):
        self.square_size = round(min(self.view.width(), self.view.height()) / self.size)
        x = self.square_size #self.square_size
        #self.grid_data = None
        #self.grid_rects = None
        #self.active_text_item = None
        #Initialize the grid data with empty strings
        self.grid_data = [[" " for _ in range(self.size)] for _ in range(self.size)]
        self.grid_rects = [[ClickableRectItem(j*x, i*x, x) for j in range(self.size)] for i in range(self.size)] #initizlizing at a size. can change size later

        self.text_items = [[QGraphicsTextItem() for _ in range(self.size)] for _ in range(self.size)]
        #self.active_text_item = self.text_items[0][0]

    def resize_grid(self, event):
        # Update the grid size based on the new window size
        self.scene.clear()
        self.draw_grid()

    def create_text_changed_handler(self, i, j):
        def handler(text):
            self.on_text_changed(text)
        return handler

    def create_text_clicked_handler(self, i, j):
        def handler():
            self.update_active(i,j)
        return handler

    #def create_rect_clicked_handler(self, i, j):
    #    def handler():
    #        print("hi")
    #        #self.update_active(i,j)
    #    return handler

    def update_active(self, i, j):
        if self.grid_data[self.active_square[0]][self.active_square[1]] != ".":
            self.draw_white_square(self.active_square[0], self.active_square[1])
        self.active_square = [i, j]  # Update active_square when text box is clicked
        #self.active_text_item = self.text_items[i][j]  # Update active_text_item when a text box is clicked
        self.color_active_square(i,j)
        print(self.active_square)
        for row in self.grid_data:
            print(row)

    def draw_grid(self):
        self.square_size = round(min(self.view.width(), self.view.height()) / self.size)
        pen = QPen(Qt.black)

        for i in range(self.size):
            for j in range(self.size):
                x = j * self.square_size
                y = i * self.square_size

                # Create a clickable rect item
                rect_item = ClickableRectItem(x, y, self.square_size)
                rect_item.clicked.connect(lambda i=i, j=j: self.on_rect_clicked(i, j))  # Connect the click signal
                self.scene.addWidget(rect_item)
                self.grid_rects[i][j] = rect_item
                font = QFont("Arial", int(self.square_size * 0.4))
                rect_item.setFont(font)

                # Create a text item for each square
                '''letter = self.grid_data[i][j]
                text_item = QGraphicsTextItem(letter)  # Replace "A" with your desired letter
                text_item.setDefaultTextColor(Qt.black)
                font = QFont("Arial", int(self.square_size * 0.4))
                text_item.setFont(font)
                text_item.setPos(x + (self.square_size - text_item.boundingRect().width()) / 2,
                                 y + (self.square_size - text_item.boundingRect().height()) / 2)
                self.scene.addItem(text_item)
                self.text_items[i][j] = text_item'''

                rect_item.setStyle("none", "black")
        self.view.setScene(self.scene)  # Update the scene in the view


    def on_rect_clicked(self, j, i): #weird swapping thing again
        self.update_active(i,j)

    def run_crossword_generator(self):
        xw = deepcopy(self.grid_data)
        for i in range(self.size):
            for j in range(self.size):
                if xw[i][j].isalpha() and xw[i][j].islower():
                    xw[i][j] = xw[i][j].upper()
                if xw[i][j] == '':
                    xw[i][j] = ' '
                elif xw[i][j] == '.':
                    xw[i][j] = '■'

        seed = [14, 12]
        #seed = [0,0]
        Generate(xw, seed)

    def on_text_changed(self, text):
        # Update the grid data when the user enters text

        i = self.active_square[0]
        j = self.active_square[1]

        print(f"{str(i)}, {str(j)}\n")
        if 0 <= i < self.size and 0 <= j < self.size:

            self.grid_data[i][j] = text

            # Print the grid data (list of lists) to the console
            for row in self.grid_data:
                print(row)

            # Check if the entered text is a period ('.') and draw a black square if it is
            if text == '.':
                self.draw_black_square(i, j)
            elif text.isalpha() or text == '':
                self.draw_white_square(i, j)

    def color_active_square(self, i, j):
        if 0 <= i < self.size and 0 <= j < self.size:
            brush = QBrush(QColor(0, 0, 255, 100))
            rect_item = self.grid_rects[i][j]
            #rect_item.setStyle(brush.color().name(), "black")
            rect_item.setStyle(f"rgba({brush.color().red()}, {brush.color().green()}, {brush.color().blue()}, {brush.color().alpha()});", "black")
            #self.scene.addWidget(rect_item)  # Add to the scene
            self.grid_rects[i][j] = rect_item

    def draw_black_square(self, i, j):
        if 0 <= i < self.size and 0 <= j < self.size:
            rect_item = self.grid_rects[i][j]
            rect_item.setStyle("black", "black")
            self.scene.addWidget(rect_item)  # Add to the scene
            self.grid_rects[i][j] = rect_item


    def draw_white_square(self, i, j):
        if 0 <= i < self.size and 0 <= j < self.size:
            rect_item = self.grid_rects[i][j]
            rect_item.setStyle("none", "black")
            self.scene.addWidget(rect_item)  # Add to the scene
            self.grid_rects[i][j] = rect_item

if __name__ == "__main__":
    app = QApplication(sys.argv)
    mainWin = SizeInputApp()
    mainWin.show()
    app.exec_()
