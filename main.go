package main

import (
	"log"

	"github.com/rockswe/justtodothings/db" // Update the module name as needed

	"github.com/gin-gonic/gin" // Web framework for handling HTTP requests
	"github.com/joho/godotenv" // Library for loading environment variables
)

func main() {
	err := godotenv.Load()

	if err != nil {
		log.Fatalf("Failed to load .env file")
	}

	db.ConnectDatabase()

	router := gin.Default()

	router.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{
			"message": "Server is running",
		})
	})

	// Start the server on port 8080
	err = router.Run(":8080")
	if err != nil {
		log.Fatalf("Error starting the server: %v", err)
	}

}
