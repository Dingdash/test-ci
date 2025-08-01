# Use a minimal base image
FROM scratch

# Set the working directory inside the container
WORKDIR /app

# Copy the application code into the container
COPY . /app

# Define the command to run when the container starts
CMD ["echo", "Hello, Docker!"]