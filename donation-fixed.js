// Stripe Integration for Donation Processing
let stripe;
let elements;
let cardElement;

// Initialize Stripe and donation form when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    initializeStripe();
});

function initializeStripe() {
    try {
        // Initialize Stripe with your publishable key
        // NOTE: Replace 'pk_test_...' with your actual Stripe publishable key
        stripe = Stripe('pk_test_51234567890abcdef'); // Replace with your actual key
        elements = stripe.elements();

        // Create card element
        cardElement = elements.create('card', {
            style: {
                base: {
                    fontSize: '16px',
                    color: '#424770',
                    fontFamily: '"Poppins", sans-serif',
                    '::placeholder': {
                        color: '#aab7c4',
                    },
                },
                invalid: {
                    color: '#9e2146',
                },
            },
        });

        // Mount card element
        cardElement.mount('#card-element');

        // Handle card element errors
        cardElement.on('change', function(event) {
            const displayError = document.getElementById('card-errors');
            if (event.error) {
                displayError.textContent = event.error.message;
                displayError.style.display = 'block';
            } else {
                displayError.textContent = '';
                displayError.style.display = 'none';
            }
        });

        // Initialize donation form
        new DonationForm();
        
    } catch (error) {
        console.error('Failed to initialize Stripe:', error);
        showStripeError();
    }
}

function showStripeError() {
    const paymentSection = document.querySelector('.payment-section');
    if (paymentSection) {
        paymentSection.innerHTML = `
            <div class="stripe-error">
                <h3><i class="fas fa-exclamation-triangle"></i> Payment System Unavailable</h3>
                <p>Our secure payment system is temporarily unavailable. Please use one of the alternative donation methods below.</p>
            </div>
        `;
    }
    
    // Highlight alternative donation methods
    const alternativeSection = document.querySelector('.alternative-donations');
    if (alternativeSection) {
        alternativeSection.scrollIntoView({ behavior: 'smooth' });
        alternativeSection.style.border = '3px solid #e74c3c';
        alternativeSection.style.borderRadius = '15px';
        setTimeout(() => {
            alternativeSection.style.border = 'none';
        }, 5000);
    }
}

// Donation form functionality
class DonationForm {
    constructor() {
        this.form = document.getElementById('donation-form');
        this.amountButtons = document.querySelectorAll('.amount-btn');
        this.customAmountInput = document.getElementById('custom-amount');
        this.frequencyOptions = document.querySelectorAll('input[name="frequency"]');
        this.selectedAmount = 0;
        this.selectedFrequency = 'one-time';
        
        this.initializeEventListeners();
        this.updateSummary();
    }

    initializeEventListeners() {
        // Amount button selection
        this.amountButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.selectAmount(btn);
            });
        });

        // Custom amount input
        this.customAmountInput.addEventListener('input', () => {
            this.handleCustomAmount();
        });

        // Frequency selection
        this.frequencyOptions.forEach(option => {
            option.addEventListener('change', () => {
                this.handleFrequencyChange(option);
            });
        });

        // Form submission
        this.form.addEventListener('submit', (e) => {
            this.handleSubmit(e);
        });
    }

    selectAmount(selectedBtn) {
        // Remove active class from all buttons
        this.amountButtons.forEach(btn => btn.classList.remove('active'));
        
        // Add active class to selected button
        selectedBtn.classList.add('active');
        
        const amount = selectedBtn.dataset.amount;
        
        if (amount === 'other') {
            this.customAmountInput.style.display = 'block';
            this.customAmountInput.focus();
            this.selectedAmount = parseFloat(this.customAmountInput.value) || 0;
        } else {
            this.customAmountInput.style.display = 'none';
            this.selectedAmount = parseInt(amount);
        }
        
        this.updateSummary();
    }

    handleCustomAmount() {
        const customValue = parseFloat(this.customAmountInput.value);
        if (customValue && customValue > 0) {
            this.selectedAmount = customValue;
            // Select the "Other" button
            const otherBtn = document.querySelector('.amount-btn[data-amount="other"]');
            this.amountButtons.forEach(btn => btn.classList.remove('active'));
            otherBtn.classList.add('active');
        } else {
            this.selectedAmount = 0;
        }
        this.updateSummary();
    }

    handleFrequencyChange(option) {
        this.selectedFrequency = option.value;
        
        // Update frequency option styling
        document.querySelectorAll('.frequency-option').forEach(opt => opt.classList.remove('active'));
        option.parentElement.classList.add('active');
        
        this.updateSummary();
    }

    updateSummary() {
        const amountElement = document.getElementById('summary-amount');
        const frequencyElement = document.getElementById('summary-frequency');
        const totalElement = document.getElementById('summary-total');
        
        amountElement.textContent = `$${this.selectedAmount.toFixed(2)}`;
        frequencyElement.textContent = this.selectedFrequency === 'one-time' ? 'One-time' : 'Monthly';
        totalElement.textContent = `$${this.selectedAmount.toFixed(2)}`;
    }

    // Enhanced form validation with better error messages
    validateForm() {
        // Clear previous errors
        this.clearErrors();
        
        const firstName = document.getElementById('first-name').value.trim();
        const lastName = document.getElementById('last-name').value.trim();
        const email = document.getElementById('email').value.trim();
        const phone = document.getElementById('phone').value.trim();
        
        let isValid = true;
        
        // Enhanced validation with specific field highlighting
        if (!firstName || firstName.length < 2) {
            this.showFieldError('first-name', 'First name must be at least 2 characters');
            isValid = false;
        }
        
        if (!lastName || lastName.length < 2) {
            this.showFieldError('last-name', 'Last name must be at least 2 characters');
            isValid = false;
        }
        
        if (!email || !this.isValidEmail(email)) {
            this.showFieldError('email', 'Please enter a valid email address');
            isValid = false;
        }
        
        if (phone && !this.isValidPhone(phone)) {
            this.showFieldError('phone', 'Please enter a valid phone number');
            isValid = false;
        }
        
        if (this.selectedAmount <= 0) {
            this.showError('Please select a donation amount.');
            this.highlightAmountSection();
            isValid = false;
        } else if (this.selectedAmount < 1) {
            this.showError('Minimum donation amount is $1.00.');
            this.highlightAmountSection();
            isValid = false;
        } else if (this.selectedAmount > 50000) {
            this.showError('Maximum donation amount is $50,000. For larger donations, please contact us directly.');
            this.highlightAmountSection();
            isValid = false;
        }
        
        return isValid;
    }

    clearErrors() {
        // Clear field-specific errors
        document.querySelectorAll('.field-error').forEach(error => {
            error.remove();
        });
        
        // Clear general errors
        const errorElement = document.getElementById('card-errors');
        errorElement.textContent = '';
        errorElement.style.display = 'none';
        
        // Remove error styling from fields
        document.querySelectorAll('.form-group input').forEach(input => {
            input.classList.remove('error');
        });
        
        // Remove amount section highlighting
        const amountSection = document.querySelector('.donation-amounts');
        if (amountSection) {
            amountSection.classList.remove('error-highlight');
        }
    }

    showFieldError(fieldId, message) {
        const field = document.getElementById(fieldId);
        const formGroup = field.closest('.form-group');
        
        // Add error styling to field
        field.classList.add('error');
        
        // Create error message element
        const errorElement = document.createElement('div');
        errorElement.className = 'field-error';
        errorElement.textContent = message;
        
        // Insert error message after the field
        formGroup.appendChild(errorElement);
        
        // Scroll to first error field
        if (!document.querySelector('.field-error:first-of-type') || field === document.querySelector('.error')) {
            field.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    highlightAmountSection() {
        const amountSection = document.querySelector('.donation-amounts');
        if (amountSection) {
            amountSection.classList.add('error-highlight');
            amountSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    isValidPhone(phone) {
        // Basic phone validation - accepts various formats
        const phoneRegex = /^[\+]?[\d\s\-\(\)\.]{10,}$/;
        return phoneRegex.test(phone);
    }

    // Enhanced email validation
    isValidEmail(email) {
        const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
        return emailRegex.test(email) && email.length <= 254 && email.length >= 5;
    }

    showError(message) {
        const errorElement = document.getElementById('card-errors');
        errorElement.textContent = message;
        errorElement.style.display = 'block';
        errorElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    showSuccess(message) {
        // Create and show success modal
        this.showModal('Success!', message, 'success');
    }

    showModal(title, message, type = 'info') {
        // Remove existing modal if any
        const existingModal = document.querySelector('.donation-modal');
        if (existingModal) {
            existingModal.remove();
        }

        const modal = document.createElement('div');
        modal.className = `donation-modal ${type}`;
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>${title}</h3>
                    <button class="modal-close">&times;</button>
                </div>
                <div class="modal-body">
                    <p>${message}</p>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-primary modal-ok">OK</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Close modal functionality
        const closeModal = () => {
            modal.remove();
        };

        modal.querySelector('.modal-close').addEventListener('click', closeModal);
        modal.querySelector('.modal-ok').addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }

    async handleSubmit(event) {
        event.preventDefault();

        if (!this.validateForm()) {
            return;
        }

        // Check if Stripe is properly initialized
        if (!stripe || !cardElement) {
            this.showError('Payment system is not available. Please use alternative donation methods below.');
            this.showAlternativeOptions();
            return;
        }

        const submitButton = document.getElementById('submit-donation');
        const originalText = submitButton.innerHTML;
        
        // Show loading state
        submitButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        submitButton.disabled = true;

        try {
            // For recurring donations, handle subscriptions
            if (this.selectedFrequency === 'monthly') {
                await this.handleRecurringDonation();
            } else {
                await this.handleOneTimeDonation();
            }
        } catch (error) {
            console.error('Payment error:', error);
            this.showError('There was an error processing your donation. Please try again or use alternative donation methods below.');
            this.showAlternativeOptions();
        } finally {
            // Restore button state
            submitButton.innerHTML = originalText;
            submitButton.disabled = false;
        }
    }

    async handleOneTimeDonation() {
        // Create payment intent on your server
        const response = await this.createPaymentIntent();
        
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }

        const { client_secret } = await response.json();

        // Confirm payment with Stripe
        const { error, paymentIntent } = await stripe.confirmCardPayment(client_secret, {
            payment_method: {
                card: cardElement,
                billing_details: {
                    name: `${document.getElementById('first-name').value} ${document.getElementById('last-name').value}`,
                    email: document.getElementById('email').value,
                    phone: document.getElementById('phone').value || undefined,
                },
            }
        });

        if (error) {
            this.showError(error.message);
        } else if (paymentIntent.status === 'succeeded') {
            this.showSuccess(`Thank you for your generous donation of $${this.selectedAmount}! Your support makes a real difference in the lives of children in Uganda. You will receive a confirmation email shortly.`);
            this.resetForm();
        }
    }

    async handleRecurringDonation() {
        // For recurring donations, we need to create a subscription
        const response = await this.createSubscription();
        
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }

        const { client_secret } = await response.json();

        // Confirm subscription payment
        const { error, setupIntent } = await stripe.confirmCardSetup(client_secret, {
            payment_method: {
                card: cardElement,
                billing_details: {
                    name: `${document.getElementById('first-name').value} ${document.getElementById('last-name').value}`,
                    email: document.getElementById('email').value,
                    phone: document.getElementById('phone').value || undefined,
                },
            }
        });

        if (error) {
            this.showError(error.message);
        } else {
            this.showSuccess(`Thank you for setting up a monthly donation of $${this.selectedAmount}! Your recurring support will make a lasting impact on children's lives in Uganda. You will receive a confirmation email shortly.`);
            this.resetForm();
        }
    }

    resetForm() {
        this.form.reset();
        this.selectedAmount = 0;
        this.selectedFrequency = 'one-time';
        this.updateSummary();
        if (cardElement) {
            cardElement.clear();
        }
        
        // Reset button states
        this.amountButtons.forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.frequency-option').forEach(opt => opt.classList.remove('active'));
        document.querySelector('.frequency-option').classList.add('active');
        this.customAmountInput.style.display = 'none';
        
        // Clear any error states
        this.clearErrors();
    }

    async createPaymentIntent() {
        const donationData = {
            amount: Math.round(this.selectedAmount * 100), // Amount in cents
            frequency: this.selectedFrequency,
            donor: {
                firstName: document.getElementById('first-name').value,
                lastName: document.getElementById('last-name').value,
                email: document.getElementById('email').value,
                phone: document.getElementById('phone').value,
            }
        };

        // Try to call your server endpoint
        try {
            return await fetch('/create-payment-intent', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(donationData),
            });
        } catch (error) {
            // If server is not available, show alternative donation methods
            this.showAlternativeOptions();
            throw new Error('Server not available. Please use alternative donation methods below.');
        }
    }

    async createSubscription() {
        const donationData = {
            amount: Math.round(this.selectedAmount * 100), // Amount in cents
            donor: {
                firstName: document.getElementById('first-name').value,
                lastName: document.getElementById('last-name').value,
                email: document.getElementById('email').value,
                phone: document.getElementById('phone').value,
            }
        };

        try {
            return await fetch('/create-subscription', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(donationData),
            });
        } catch (error) {
            this.showAlternativeOptions();
            throw new Error('Server not available. Please use alternative donation methods below.');
        }
    }

    showAlternativeOptions() {
        const alternativeSection = document.querySelector('.alternative-donations');
        if (alternativeSection) {
            alternativeSection.scrollIntoView({ behavior: 'smooth' });
            alternativeSection.style.border = '3px solid #4a90e2';
            alternativeSection.style.borderRadius = '15px';
            setTimeout(() => {
                alternativeSection.style.border = 'none';
            }, 3000);
        }
    }
}
