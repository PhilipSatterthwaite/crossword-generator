# Function to solve the crossword

from copy import copy, deepcopy
from word_list import make_word_list
import time
import datetime
import statistics
import sys
import string #import ascii_upperrcase
import pdb

import numpy as np
from scipy.optimize import minimize, Bounds, NonlinearConstraint
sys.path.append(r'C:\Users\psatt\AppData\Local\Packages\PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0\LocalCache\local-packages\Python311\site-packages')

from pytrie import StringTrie








def solve_xword(xw, wordDataBase, wordDataBase_list, wordList,wordsInPuzzle,lastPrint, numWords):
        
    #def objective_function(constraint_flags):
    #    return -np.count_nonzero(constraint_flags)  # Minimize the number of False (unsatisfied) constraints

        #return -np.sum(constraint_flags)  # Minimize the negation of the number of satisfied constraints

    def objective_function(constraint_values):
        # Calculate the number of unsatisfied constraints
        return - np.sum(constraint_values)

        

    
        #diff_constraints = [
            #np.dot(v1, v2) == 0,
            #np.dot(v1, v3) == 0,
            #np.dot(v1, v4) == 0,
            #np.dot(v1, v5) == 0,
            #np.dot(v1, v6) == 0,
            #np.dot(v2, v3) == 0,
            #np.dot(v2, v4) == 0,
            #np.dot(v2, v5) == 0,
            #np.dot(v2, v6) == 0,
            #np.dot(v3, v4) == 0,
            #np.dot(v3, v5) == 0,
            #np.dot(v3, v6) == 0,
            #np.dot(v4, v5) == 0,
            #np.dot(v4, v6) == 0,
            #np.dot(v5, v6) == 0
        #]

        
    def equality_constraints(variables):
        v1 = variables[:3]
        v2 = variables[3:6]
        v3 = variables[6:9]
        v4 = variables[9:12]
        v5 = variables[12:15]
        v6 = variables[15:]

        constraints = [
            int(v1[0] == v4[0]),
            int(v1[1] == v5[0]),
            int(v1[2] == v6[0]),
            int(v2[0] == v4[1]),
            int(v2[1] == v5[1]),
            int(v2[2] == v6[1]),
            int(v3[0] == v4[2]),
            int(v3[1] == v5[2]),
            int(v3[2] == v6[2]),
        ]
        


        sum_diffs = []
        for v in [v1, v4]:#, v3, v4, v5, v6]:
            diffs = [np.sum(np.abs(v - vector)) for vector in valid_vectors]
            sum_diffs.append(min(diffs))  # Get the minimum sum of differences for each vector

        
        
        '''
        constraint1 = np.logical_xor(v1[0], v4[0])
        constraint2 = np.logical_xor(v1[1], v5[0])
        constraint3 = np.logical_xor(v1[2], v6[0])
        constraint4 = np.logical_xor(v2[0], v4[1])
        constraint5 = np.logical_xor(v2[1], v5[1])
        constraint6 = np.logical_xor(v2[2], v6[1])
        constraint7 = np.logical_xor(v3[0], v4[2])
        constraint8 = np.logical_xor(v3[1], v5[2])
        constraint9 = np.logical_xor(v3[2], v6[2])
      
        # Equality constraints
        constraint1 = v1[0] == v4[0]
        constraint2 = v1[1] == v5[0]
        constraint3 = v1[2] == v6[0]
        constraint4 = v2[0] == v4[1]
        constraint5 = v2[1] == v5[1]
        constraint6 = v2[2] == v6[1]
        constraint7 = v3[0] == v4[2]
        constraint8 = v3[1] == v5[2]
        constraint9 = v3[2] == v6[2]
      
        # Valid constraints
        #valid_constraints = [
        #    np.array_equal(v1, vector) for vector in valid_vectors
        #] + [
        #    np.array_equal(v2, vector) for vector in valid_vectors
        #] + [
        #    np.array_equal(v3, vector) for vector in valid_vectors
        #] + [
        #    np.array_equal(v4, vector) for vector in valid_vectors
        #] + [
        #    np.array_equal(v5, vector) for vector in valid_vectors
        #] + [
        #    np.array_equal(v6, vector) for vector in valid_vectors
        #]

        all_constraints = [
            constraint1, constraint2, constraint3,
            constraint4, constraint5, constraint6,
            constraint7, constraint8, constraint9
        ] #+ valid_constraints
        
        '''
        return constraints #+ sum_diffs


    dataBase_vecs = to_vector(wordDataBase_list)
    valid_vectors = dataBase_vecs[0]
    print(valid_vectors[0])
    print(len(valid_vectors))
    initial_guess = np.random.randint(65, 91, size=18)  # Random integers between 65 (A) and 90 (Z)
    initial_guess = [65] * 18
    print(initial_guess)

    
    # Number of variables (18 components of 6 vectors)
    num_vars = 18

    integer_constraints = NonlinearConstraint(lambda x: x % 1, 0, 0, jac="2-point")
    bounds = [(66, 90)] * len(initial_guess)
   
    
    # Define the optimization problem using the minimize function
    optimization_result = minimize(
        fun=objective_function,
        x0=initial_guess,
        constraints=[{'type': 'eq', 'fun': equality_constraints}],
        bounds=bounds,  # Add bounds to ensure integer variables
        method='SLSQP',
        options={'disp': True}
    )

    # Check if the optimization was successful
    if not optimization_result.success:
        print("Optimization failed:", optimization_result.message)
        return

    # Extract the optimized solution
    optimized_solution = optimization_result.x

    # Reshape the optimized solution into 6 vectors of 3 components each
    optimized_vectors = np.array(optimized_solution).reshape(6, 3)

    # Print the results
    print("Optimized Solution:")
    print(optimized_vectors)
    print("Optimal Objective Value:", optimization_result.fun)



def to_vector(list_of_word_lists):
    vector_lists = []

    for word_list in list_of_word_lists:
        vector_list = []
        for word in word_list:
            word_vector = []
            for letter in word:
                ascii_value = ord(letter)  # Get ASCII value of the letter
                word_vector.append(ascii_value)
            vector_list.append(word_vector)
        vector_lists.append(vector_list)

    return vector_lists




